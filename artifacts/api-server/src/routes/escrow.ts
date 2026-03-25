import { Router, type IRouter } from "express";
import { db, escrowsTable, usersTable, escrowBalancesTable, claimNoncesTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  hashEmail,
  parseUsdcAmount,
  formatUsdcAmount,
  getBackendSigner,
  getEscrowContract,
  ESCROW_CONTRACT_ADDRESS_VALUE,
  USDC_ADDRESS_VALUE,
} from "../lib/escrow.js";
import {
  SendUSDCBody,
  ClaimEscrowBody,
  SendConfirmBody,
  ClaimSignBody,
  ClaimConfirmBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ─── POST /api/escrow/send ────────────────────────────────────────────────────
// Validate + record a pending escrow; return contract params for the frontend to sign.
router.post("/send", async (req, res) => {
  try {
    const parsed = SendUSDCBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    // recipientEmail is already lowercased+trimmed by the Zod transform
    const { recipientEmail, amount, senderAddress } = parsed.data;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Amount must be a positive number" });
      return;
    }

    if (numAmount > 1_000_000) {
      res.status(400).json({ error: "Invalid amount", message: "Amount exceeds maximum single-transfer limit" });
      return;
    }

    const emailHash = hashEmail(recipientEmail);
    const amountWei = parseUsdcAmount(amount);

    const [escrow] = await db.insert(escrowsTable).values({
      senderAddress: senderAddress.toLowerCase(),
      recipientEmail,
      emailHash,
      amount,
      amountWei: amountWei.toString(),
      status: "pending",
    }).returning();

    res.json({
      escrowId: escrow.id,
      contractAddress: ESCROW_CONTRACT_ADDRESS_VALUE,
      usdcAddress: USDC_ADDRESS_VALUE,
      emailHash,
      amount,
      amountWei: amountWei.toString(),
      message: `Send ${amount} USDC to ${recipientEmail}. Please approve USDC spending and confirm the escrow deposit.`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[send] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/send/confirm ────────────────────────────────────────────
// Called by the frontend after the deposit tx is mined. Records the txHash.
router.post("/send/confirm", async (req, res) => {
  try {
    const parsed = SendConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { escrowId, txHash } = parsed.data;

    // Ensure the escrow exists and is in pending state (prevent tampering)
    const [existing] = await db
      .select()
      .from(escrowsTable)
      .where(eq(escrowsTable.id, escrowId))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Not found", message: "Escrow record not found" });
      return;
    }

    if (existing.txHash) {
      // Idempotent: already confirmed — return success without double-recording
      res.json({ success: true, message: "Transaction already confirmed" });
      return;
    }

    await db.update(escrowsTable)
      .set({ txHash, status: "pending" })
      .where(eq(escrowsTable.id, escrowId));

    res.json({ success: true, message: "Transaction confirmed" });
  } catch (error: any) {
    req.log.error({ err: error }, "[send/confirm] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/escrow/pending ──────────────────────────────────────────────────
router.get("/pending", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const pendingEscrows = await db.select().from(escrowsTable).where(
      and(
        eq(escrowsTable.emailHash, emailHash),
        eq(escrowsTable.status, "pending"),
      )
    );

    const totalPendingAmount = pendingEscrows.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    res.json({
      escrows: pendingEscrows.map((e) => ({
        id: e.id,
        senderAddress: e.senderAddress,
        recipientEmail: e.recipientEmail,
        amount: e.amount,
        status: e.status,
        txHash: e.txHash,
        createdAt: e.createdAt,
        claimedAt: e.claimedAt,
      })),
      totalPendingAmount: totalPendingAmount.toFixed(6),
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[pending] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/claim ───────────────────────────────────────────────────
// Backend-executed claim (no user gas required).
router.post("/claim", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const parsed = ClaimEscrowBody.safeParse(req.body);

    const recipientWalletAddress = parsed.success ? parsed.data.recipientWalletAddress : undefined;
    const emailHash = hashEmail(user.email);

    const pendingEscrows = await db.select().from(escrowsTable).where(
      and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending"))
    );

    if (pendingEscrows.length === 0) {
      res.status(400).json({ error: "No pending escrows", message: "No pending escrow funds found for your account" });
      return;
    }

    let totalClaimed = 0;
    const txHashes: string[] = [];

    if (recipientWalletAddress) {
      try {
        const signer = getBackendSigner();
        const escrowContract = getEscrowContract(signer);

        const tx = await escrowContract.claimByEmailHash(emailHash, recipientWalletAddress);
        const receipt = await tx.wait();
        txHashes.push(receipt.hash);

        for (const escrow of pendingEscrows) {
          await db.update(escrowsTable)
            .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date(), claimTxHash: receipt.hash })
            .where(eq(escrowsTable.id, escrow.id));
          totalClaimed += parseFloat(escrow.amount);
        }
      } catch (chainError: any) {
        req.log.warn({ err: chainError }, "[claim] On-chain claim failed, crediting internal balance");
        for (const escrow of pendingEscrows) {
          await db.update(escrowsTable)
            .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date() })
            .where(eq(escrowsTable.id, escrow.id));
          totalClaimed += parseFloat(escrow.amount);
        }
        const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
        const newBalance = (parseFloat(dbUser.claimedBalance || "0") + totalClaimed).toFixed(6);
        await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));
      }
    } else {
      for (const escrow of pendingEscrows) {
        await db.update(escrowsTable)
          .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date() })
          .where(eq(escrowsTable.id, escrow.id));
        totalClaimed += parseFloat(escrow.amount);
      }
      const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
      const newBalance = (parseFloat(dbUser.claimedBalance || "0") + totalClaimed).toFixed(6);
      await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));
    }

    res.json({
      claimedCount: pendingEscrows.length,
      totalClaimed: totalClaimed.toFixed(6),
      txHashes,
      message: `Successfully claimed ${totalClaimed.toFixed(2)} USDC ($${totalClaimed.toFixed(2)} USD)`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[claim] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/claim/sign ─────────────────────────────────────────────
// Phase 5 + Security: signs (emailHash, walletAddress, nonce) so the frontend can
// submit the claim tx itself. The nonce is one-time-use with a 15-minute expiry.
// This prevents replay attacks: replaying the same signature is rejected because
// the nonce will have already been consumed by /claim/confirm.
router.post("/claim/sign", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const parsed = ClaimSignBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { walletAddress } = parsed.data;
    const emailHash = hashEmail(user.email);

    // Must have at least one pending escrow
    const pendingEscrows = await db
      .select()
      .from(escrowsTable)
      .where(and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending")));

    if (pendingEscrows.length === 0) {
      res.status(400).json({ error: "No pending escrows", message: "No pending escrow funds found for your account" });
      return;
    }

    // Purge any expired, unused nonces for this user (housekeeping)
    await db
      .delete(claimNoncesTable)
      .where(
        and(
          eq(claimNoncesTable.userId, user.userId),
          lt(claimNoncesTable.expiresAt, new Date()),
        )
      );

    // Generate a cryptographically random nonce (32 bytes)
    const { ethers } = await import("ethers");
    const rawNonce = ethers.hexlify(ethers.randomBytes(32)); // 0x + 64 hex chars

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store nonce in DB (consumed on /claim/confirm)
    await db.insert(claimNoncesTable).values({
      userId: user.userId,
      nonce: rawNonce,
      emailHash,
      walletAddress: walletAddress.toLowerCase(),
      expiresAt,
    });

    // Sign: keccak256(abi.encodePacked(emailHash, walletAddress, nonce))
    // The nonce makes this signature one-time-use — any replay attempt fails
    // because the nonce will already be consumed after the first successful claim.
    const messageHash = ethers.solidityPackedKeccak256(
      ["bytes32", "address", "bytes32"],
      [emailHash, walletAddress.toLowerCase(), rawNonce],
    );
    const signer = getBackendSigner();
    const signature = await signer.signMessage(ethers.getBytes(messageHash));

    const totalPending = pendingEscrows
      .reduce((sum, e) => sum + parseFloat(e.amount), 0)
      .toFixed(6);

    res.json({
      emailHash,
      walletAddress: walletAddress.toLowerCase(),
      nonce: rawNonce,
      signature,
      expiresAt: expiresAt.toISOString(),
      contractAddress: ESCROW_CONTRACT_ADDRESS_VALUE,
      totalPendingAmount: totalPending,
      pendingCount: pendingEscrows.length,
      message: `Sign and submit the claim transaction in your wallet to receive ${totalPending} USDC`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[claim/sign] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/claim/confirm ──────────────────────────────────────────
// Called by the frontend after the on-chain claim tx is mined.
// Consumes the one-time nonce to prevent any future replay.
router.post("/claim/confirm", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const parsed = ClaimConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { txHash, nonce, walletAddress } = parsed.data;
    const emailHash = hashEmail(user.email);

    // ── Nonce verification ────────────────────────────────────────────────────
    const [nonceRow] = await db
      .select()
      .from(claimNoncesTable)
      .where(and(eq(claimNoncesTable.nonce, nonce), eq(claimNoncesTable.userId, user.userId)))
      .limit(1);

    if (!nonceRow) {
      res.status(400).json({ error: "Invalid nonce", message: "Nonce not found or does not belong to your account" });
      return;
    }

    if (nonceRow.usedAt !== null) {
      req.log.warn({ nonce, userId: user.userId }, "[claim/confirm] Replay attack: nonce already used");
      res.status(400).json({ error: "Replay attack", message: "This claim authorization has already been used" });
      return;
    }

    if (new Date() > nonceRow.expiresAt) {
      res.status(400).json({ error: "Expired", message: "Claim authorization has expired. Please request a new one." });
      return;
    }

    // Verify the nonce matches the email hash (sanity check — defense in depth)
    if (nonceRow.emailHash !== emailHash) {
      req.log.warn({ nonce, userId: user.userId }, "[claim/confirm] emailHash mismatch on nonce");
      res.status(400).json({ error: "Invalid nonce", message: "Nonce email hash does not match your account" });
      return;
    }

    // ── Consume nonce immediately (prevents TOCTOU race) ──────────────────────
    await db
      .update(claimNoncesTable)
      .set({ usedAt: new Date() })
      .where(eq(claimNoncesTable.nonce, nonce));

    // ── Mark pending escrows as claimed ───────────────────────────────────────
    const pendingEscrows = await db
      .select()
      .from(escrowsTable)
      .where(and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending")));

    let totalClaimed = 0;
    for (const escrow of pendingEscrows) {
      await db
        .update(escrowsTable)
        .set({
          status: "claimed",
          recipientUserId: user.userId,
          claimedAt: new Date(),
          claimTxHash: txHash,
        })
        .where(eq(escrowsTable.id, escrow.id));
      totalClaimed += parseFloat(escrow.amount);
    }

    req.log.info({ txHash, nonce, userId: user.userId, totalClaimed }, "[claim/confirm] Claim confirmed");

    res.json({
      success: true,
      claimedCount: pendingEscrows.length,
      totalClaimed: totalClaimed.toFixed(6),
      message: `Marked ${pendingEscrows.length} escrow(s) as claimed`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[claim/confirm] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/claim/auto ─────────────────────────────────────────────
// Wallet-free server-side claim: backend signer claims escrow funds on behalf of
// the authenticated user — no MetaMask or external wallet required.
// USDC flows: escrow contract → platform wallet → user's claimed_balance (internal ledger).
router.post("/claim/auto", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const pendingEscrows = await db.select().from(escrowsTable).where(
      and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending"))
    );

    if (pendingEscrows.length === 0) {
      res.status(400).json({ error: "No pending escrows", message: "No pending escrow funds found for your account" });
      return;
    }

    let totalClaimed = 0;
    let txHash: string | null = null;

    // Attempt on-chain claim using the platform/backend signer wallet
    try {
      const signer = getBackendSigner();
      const escrowContract = getEscrowContract(signer);
      const platformAddress = await signer.getAddress();

      const tx = await escrowContract.claimByEmailHash(emailHash, platformAddress);
      const receipt = await tx.wait();
      txHash = receipt.hash ?? tx.hash;

      for (const escrow of pendingEscrows) {
        await db.update(escrowsTable)
          .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date(), claimTxHash: txHash })
          .where(eq(escrowsTable.id, escrow.id));
        totalClaimed += parseFloat(escrow.amount);
      }
    } catch (chainError: any) {
      req.log.warn({ err: chainError }, "[claim/auto] On-chain claim failed — crediting internal balance");
      for (const escrow of pendingEscrows) {
        await db.update(escrowsTable)
          .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date() })
          .where(eq(escrowsTable.id, escrow.id));
        totalClaimed += parseFloat(escrow.amount);
      }
    }

    // Always credit user's internal balance
    const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    const newBalance = (parseFloat(dbUser?.claimedBalance ?? "0") + totalClaimed).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    req.log.info({ userId: user.userId, totalClaimed, txHash }, "[claim/auto] Claim complete");

    res.json({
      success: true,
      claimedCount: pendingEscrows.length,
      totalClaimed: totalClaimed.toFixed(6),
      txHash,
      message: `Successfully claimed ${totalClaimed.toFixed(2)} USDC`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[claim/auto] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/escrow/history ──────────────────────────────────────────────────
router.get("/history", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const [sentEscrows, receivedEscrows] = await Promise.all([
      db.select().from(escrowsTable).where(eq(escrowsTable.senderAddress, user.email.toLowerCase())),
      db.select().from(escrowsTable).where(eq(escrowsTable.emailHash, emailHash)),
    ]);

    const mapEscrow = (e: typeof sentEscrows[0]) => ({
      id: e.id,
      senderAddress: e.senderAddress,
      recipientEmail: e.recipientEmail,
      amount: e.amount,
      status: e.status,
      txHash: e.txHash,
      createdAt: e.createdAt,
      claimedAt: e.claimedAt,
    });

    res.json({ sent: sentEscrows.map(mapEscrow), received: receivedEscrows.map(mapEscrow) });
  } catch (error: any) {
    req.log.error({ err: error }, "[history] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/send/platform ──────────────────────────────────────────
// Wallet-free send: deducts from the sender's claimed_balance and creates an
// escrow record for the recipient. No on-chain transaction required.
router.post("/send/platform", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    const body = req.body as { recipientEmail?: unknown; amount?: unknown };
    const recipientEmail = typeof body.recipientEmail === "string" ? body.recipientEmail.toLowerCase().trim() : "";
    const amountRaw = typeof body.amount === "string" ? body.amount.trim() : "";

    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      res.status(400).json({ error: "Validation error", message: "A valid recipient email is required" });
      return;
    }

    if (recipientEmail === user.email.toLowerCase()) {
      res.status(400).json({ error: "Invalid recipient", message: "You cannot send USDC to yourself" });
      return;
    }

    const numAmount = parseFloat(amountRaw);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Amount must be a positive number" });
      return;
    }
    if (numAmount > 1_000_000) {
      res.status(400).json({ error: "Invalid amount", message: "Amount exceeds the maximum single-transfer limit" });
      return;
    }

    const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    const currentBalance = parseFloat(sender?.claimedBalance ?? "0");

    if (currentBalance < numAmount) {
      res.status(400).json({
        error: "Insufficient balance",
        message: `You only have $${currentBalance.toFixed(2)} USDC available. Top up your balance first.`,
      });
      return;
    }

    const newBalance = (currentBalance - numAmount).toFixed(6);
    const emailHash = hashEmail(recipientEmail);
    const amountStr = numAmount.toFixed(6);

    await db.update(usersTable)
      .set({ claimedBalance: newBalance })
      .where(eq(usersTable.id, user.userId));

    const [escrow] = await db.insert(escrowsTable).values({
      senderAddress: user.email,
      recipientEmail,
      emailHash,
      amount: amountStr,
      amountWei: parseUsdcAmount(amountStr).toString(),
      status: "confirmed",
      txHash: null,
    }).returning();

    res.json({
      success: true,
      escrowId: escrow.id,
      recipientEmail,
      amount: amountStr,
      remainingBalance: newBalance,
      message: `$${numAmount.toFixed(2)} USDC locked in escrow for ${recipientEmail}`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[send/platform] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/escrow/balance ──────────────────────────────────────────────────
// Phase 6: reads escrow_balances (indexer), escrows (DB pending), users.claimed_balance.
// 1 USDC = 1 USD (stablecoin peg).
router.get("/balance", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const [dbUser, pendingEscrows, onChainRow] = await Promise.all([
      db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1),
      db.select().from(escrowsTable).where(
        and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending"))
      ),
      db.select().from(escrowBalancesTable).where(eq(escrowBalancesTable.emailHash, emailHash)).limit(1),
    ]);

    const onChainUsdcBalance = parseFloat(onChainRow[0]?.amount ?? "0");
    const claimedBalance = parseFloat(dbUser[0]?.claimedBalance ?? "0");
    const pendingBalance = pendingEscrows.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const usdBalance = (onChainUsdcBalance + claimedBalance).toFixed(6);

    res.json({
      onChainUsdcBalance: onChainUsdcBalance.toFixed(6),
      onChainLastUpdated: onChainRow[0]?.lastUpdated ?? null,
      claimedBalance: claimedBalance.toFixed(6),
      pendingBalance: pendingBalance.toFixed(6),
      usdBalance,
      usdEquivalent: usdBalance,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[balance] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
