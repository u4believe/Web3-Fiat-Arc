import { Router, type IRouter } from "express";
import { db, escrowsTable, usersTable, escrowBalancesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcrypt";
import { requireAuth, requireEmailVerified } from "../lib/auth.js";
import { hashEmail, parseUsdcAmount } from "../lib/escrow.js";

const router: IRouter = Router();

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
// Credits all pending escrows for the authenticated user to their balance.
router.post("/claim", requireAuth, async (req, res) => {
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
    for (const escrow of pendingEscrows) {
      await db.update(escrowsTable)
        .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date() })
        .where(eq(escrowsTable.id, escrow.id));
      totalClaimed += parseFloat(escrow.amount);
    }

    const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    const newBalance = (parseFloat(dbUser.claimedBalance || "0") + totalClaimed).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    res.json({
      claimedCount: pendingEscrows.length,
      totalClaimed: totalClaimed.toFixed(6),
      message: `Successfully claimed $${totalClaimed.toFixed(2)} USD`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[claim] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/escrow/claim/auto ─────────────────────────────────────────────
// Alias of /claim — credits all pending escrows to the user's balance.
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
    for (const escrow of pendingEscrows) {
      await db.update(escrowsTable)
        .set({ status: "claimed", recipientUserId: user.userId, claimedAt: new Date() })
        .where(eq(escrowsTable.id, escrow.id));
      totalClaimed += parseFloat(escrow.amount);
    }

    const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    const newBalance = (parseFloat(dbUser?.claimedBalance ?? "0") + totalClaimed).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    req.log.info({ userId: user.userId, totalClaimed }, "[claim/auto] Claim complete");

    res.json({
      success: true,
      claimedCount: pendingEscrows.length,
      totalClaimed: totalClaimed.toFixed(6),
      txHash: null,
      message: `Successfully claimed $${totalClaimed.toFixed(2)} USD`,
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
// Deducts from the sender's balance and creates an escrow record for the recipient.
router.post("/send/platform", requireAuth, requireEmailVerified, async (req, res) => {
  try {
    const user = (req as any).user;

    const body = req.body as { recipientEmail?: unknown; amount?: unknown; transactionPassword?: unknown };
    const recipientEmail = typeof body.recipientEmail === "string" ? body.recipientEmail.toLowerCase().trim() : "";
    const amountRaw = typeof body.amount === "string" ? body.amount.trim() : "";

    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      res.status(400).json({ error: "Validation error", message: "A valid recipient email is required" });
      return;
    }

    if (recipientEmail === user.email.toLowerCase()) {
      res.status(400).json({ error: "Invalid recipient", message: "You cannot send money to yourself" });
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

    if (sender?.transactionPasswordHash) {
      const txnPwd = typeof body.transactionPassword === "string" ? body.transactionPassword : "";
      if (!txnPwd) {
        res.status(403).json({ error: "Transaction password required", message: "Please enter your transaction password to authorize this transfer" });
        return;
      }
      const txnPwdValid = await bcrypt.compare(txnPwd, sender.transactionPasswordHash);
      if (!txnPwdValid) {
        res.status(403).json({ error: "Invalid transaction password", message: "The transaction password you entered is incorrect" });
        return;
      }
    }

    if (currentBalance < numAmount) {
      res.status(400).json({
        error: "Insufficient balance",
        message: `You only have $${currentBalance.toFixed(2)} available. Top up your balance first.`,
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
      status: "pending",
      txHash: null,
    }).returning();

    res.json({
      success: true,
      escrowId: escrow.id,
      recipientEmail,
      amount: amountStr,
      remainingBalance: newBalance,
      message: `$${numAmount.toFixed(2)} locked in escrow for ${recipientEmail}`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[send/platform] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/escrow/balance ──────────────────────────────────────────────────
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
