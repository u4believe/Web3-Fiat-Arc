import { Router, type IRouter } from "express";
import { db, escrowsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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
import { SendUSDCBody, ClaimEscrowBody } from "@workspace/api-zod";

const router: IRouter = Router();

// POST /api/escrow/send - prepare escrow transaction info for frontend signing
router.post("/send", async (req, res) => {
  try {
    const parsed = SendUSDCBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { recipientEmail, amount, senderAddress } = parsed.data;

    // Validate amount
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Amount must be a positive number" });
      return;
    }

    const emailHash = hashEmail(recipientEmail);
    const amountWei = parseUsdcAmount(amount);

    // Record the pending escrow in our DB
    const [escrow] = await db.insert(escrowsTable).values({
      senderAddress: senderAddress.toLowerCase(),
      recipientEmail: recipientEmail.toLowerCase(),
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
      message: `Send ${amount} USDC to ${recipientEmail}. Please approve USDC spending and confirm the escrow deposit transaction.`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Send USDC error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// POST /api/escrow/send/confirm - called by frontend after tx is confirmed
router.post("/send/confirm", async (req, res) => {
  try {
    const { escrowId, txHash } = req.body;
    if (!escrowId || !txHash) {
      res.status(400).json({ error: "Invalid request", message: "escrowId and txHash are required" });
      return;
    }

    await db.update(escrowsTable)
      .set({ txHash, status: "pending" })
      .where(eq(escrowsTable.id, escrowId));

    res.json({ success: true, message: "Transaction confirmed" });
  } catch (error: any) {
    req.log.error({ err: error }, "Confirm escrow error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// GET /api/escrow/pending - get pending escrows for logged-in user
router.get("/pending", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const pendingEscrows = await db.select().from(escrowsTable).where(
      and(
        eq(escrowsTable.emailHash, emailHash),
        eq(escrowsTable.status, "pending")
      )
    );

    const totalPendingAmount = pendingEscrows.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    res.json({
      escrows: pendingEscrows.map(e => ({
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
    req.log.error({ err: error }, "Get pending escrows error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// POST /api/escrow/claim - backend claims on behalf of user
router.post("/claim", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const parsed = ClaimEscrowBody.safeParse(req.body);
    
    const recipientWalletAddress = parsed.success ? parsed.data.recipientWalletAddress : undefined;
    const emailHash = hashEmail(user.email);

    const pendingEscrows = await db.select().from(escrowsTable).where(
      and(
        eq(escrowsTable.emailHash, emailHash),
        eq(escrowsTable.status, "pending")
      )
    );

    if (pendingEscrows.length === 0) {
      res.status(400).json({ error: "No pending escrows", message: "No pending escrow funds found for your account" });
      return;
    }

    let totalClaimed = 0;
    const txHashes: string[] = [];

    // If a wallet address is provided, try to claim on-chain
    if (recipientWalletAddress) {
      try {
        const signer = getBackendSigner();
        const escrowContract = getEscrowContract(signer);

        const tx = await escrowContract.claimByEmailHash(emailHash, recipientWalletAddress);
        const receipt = await tx.wait();
        txHashes.push(receipt.hash);

        // Mark all as claimed
        for (const escrow of pendingEscrows) {
          await db.update(escrowsTable)
            .set({
              status: "claimed",
              recipientUserId: user.userId,
              claimedAt: new Date(),
              claimTxHash: receipt.hash,
            })
            .where(eq(escrowsTable.id, escrow.id));
          totalClaimed += parseFloat(escrow.amount);
        }
      } catch (chainError: any) {
        // If on-chain claim fails (e.g., contract doesn't have that function or testnet issues),
        // fall back to crediting the user's internal balance
        req.log.warn({ err: chainError }, "On-chain claim failed, crediting internal balance");
        
        for (const escrow of pendingEscrows) {
          await db.update(escrowsTable)
            .set({
              status: "claimed",
              recipientUserId: user.userId,
              claimedAt: new Date(),
            })
            .where(eq(escrowsTable.id, escrow.id));
          totalClaimed += parseFloat(escrow.amount);
        }

        // Credit user's internal balance
        const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
        const newBalance = (parseFloat(dbUser.claimedBalance || "0") + totalClaimed).toFixed(6);
        await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));
      }
    } else {
      // No wallet address - credit internal balance
      for (const escrow of pendingEscrows) {
        await db.update(escrowsTable)
          .set({
            status: "claimed",
            recipientUserId: user.userId,
            claimedAt: new Date(),
          })
          .where(eq(escrowsTable.id, escrow.id));
        totalClaimed += parseFloat(escrow.amount);
      }

      // Credit user's internal balance
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
    req.log.error({ err: error }, "Claim escrow error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// GET /api/escrow/history - transaction history
router.get("/history", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const [sentEscrows, receivedEscrows] = await Promise.all([
      db.select().from(escrowsTable).where(eq(escrowsTable.senderAddress, user.email.toLowerCase())),
      db.select().from(escrowsTable).where(eq(escrowsTable.emailHash, emailHash)),
    ]);

    res.json({
      sent: sentEscrows.map(e => ({
        id: e.id,
        senderAddress: e.senderAddress,
        recipientEmail: e.recipientEmail,
        amount: e.amount,
        status: e.status,
        txHash: e.txHash,
        createdAt: e.createdAt,
        claimedAt: e.claimedAt,
      })),
      received: receivedEscrows.map(e => ({
        id: e.id,
        senderAddress: e.senderAddress,
        recipientEmail: e.recipientEmail,
        amount: e.amount,
        status: e.status,
        txHash: e.txHash,
        createdAt: e.createdAt,
        claimedAt: e.claimedAt,
      })),
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Get history error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// GET /api/escrow/balance
router.get("/balance", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const [dbUser, pendingEscrows] = await Promise.all([
      db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1),
      db.select().from(escrowsTable).where(
        and(
          eq(escrowsTable.emailHash, emailHash),
          eq(escrowsTable.status, "pending")
        )
      ),
    ]);

    const claimedBalance = parseFloat(dbUser[0]?.claimedBalance || "0");
    const pendingBalance = pendingEscrows.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const usdEquivalent = (claimedBalance + pendingBalance).toFixed(6);

    res.json({
      claimedBalance: claimedBalance.toFixed(6),
      pendingBalance: pendingBalance.toFixed(6),
      usdEquivalent,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Get balance error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
