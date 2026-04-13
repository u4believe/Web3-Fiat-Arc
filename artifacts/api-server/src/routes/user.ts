import { Router, type IRouter } from "express";
import { db, usersTable, depositsTable, withdrawalsTable, escrowsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { hashEmail } from "../lib/escrow.js";

const router: IRouter = Router();

// ─── GET /api/user/history ────────────────────────────────────────────────────
// Returns a unified, date-sorted list of all transactions for the logged-in user:
//   • USDC deposits (on-chain, any supported chain)
//   • USDC crypto withdrawals + USD fiat withdrawals
//   • USD escrow transfers (sent and received)
//
// Each entry includes counterparty info (sender address, recipient address/email,
// bank destination, blockchain network) so the frontend can display full details.

router.get("/history", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const emailHash = hashEmail(user.email);

    const [deposits, withdrawals, sentEscrows, receivedEscrows] = await Promise.all([
      db
        .select()
        .from(depositsTable)
        .where(eq(depositsTable.userId, user.userId))
        .orderBy(desc(depositsTable.createdAt))
        .limit(100),

      db
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.userId, user.userId))
        .orderBy(desc(withdrawalsTable.createdAt))
        .limit(100),

      db
        .select()
        .from(escrowsTable)
        .where(eq(escrowsTable.senderAddress, user.email.toLowerCase()))
        .orderBy(desc(escrowsTable.createdAt))
        .limit(100),

      db
        .select()
        .from(escrowsTable)
        .where(eq(escrowsTable.emailHash, emailHash))
        .orderBy(desc(escrowsTable.createdAt))
        .limit(100),
    ]);

    // ── Map deposits → unified format ────────────────────────────────────────
    const depositEntries = deposits.map((d) => ({
      id:        `dep-${d.id}`,
      category:  "deposit" as const,
      currency:  d.type === "bank" ? "USD" : "USDC",
      direction: "in" as const,
      amount:    d.amount,
      status:    d.status,
      network:   d.source,          // e.g. "Base Sepolia USDC" or "Bank transfer"
      txHash:    d.txHash ?? null,
      // For on-chain deposits we have the txHash but not the sender address —
      // the sender is whoever submitted the on-chain Transfer. Surface the hash
      // so the user can look it up on a block explorer.
      fromAddress: null,
      toAddress:   null,
      description: d.source,
      createdAt:   d.createdAt,
      completedAt: d.creditedAt ?? null,
    }));

    // ── Map withdrawals → unified format ─────────────────────────────────────
    const withdrawalEntries = withdrawals.map((w) => ({
      id:          `wd-${w.id}`,
      category:    "withdrawal" as const,
      currency:    w.type === "fiat" ? "USD" : "USDC",
      direction:   "out" as const,
      amount:      w.amount,
      status:      w.status,
      network:     w.type === "crypto" ? "On-chain" : "Bank transfer",
      txHash:      w.txHash ?? null,
      fromAddress: null,
      // destination is a wallet address (crypto) or bank details string (fiat)
      toAddress:   w.destination,
      description: w.type === "crypto"
        ? `Sent to ${w.destination}`
        : `Bank withdrawal — ${w.destination}`,
      createdAt:   w.createdAt,
      completedAt: w.completedAt ?? null,
    }));

    // ── Map escrows → unified format ─────────────────────────────────────────
    const sentEntries = sentEscrows.map((e) => ({
      id:          `esc-s-${e.id}`,
      category:    "escrow" as const,
      currency:    "USD" as const,
      direction:   "out" as const,
      amount:      e.amount,
      status:      e.status,
      network:     "Arc Platform",
      txHash:      e.txHash ?? null,
      fromAddress: e.senderAddress,
      toAddress:   e.recipientEmail,
      description: `Sent to ${e.recipientEmail}`,
      createdAt:   e.createdAt,
      completedAt: e.claimedAt ?? null,
    }));

    const receivedEntries = receivedEscrows.map((e) => ({
      id:          `esc-r-${e.id}`,
      category:    "escrow" as const,
      currency:    "USD" as const,
      direction:   "in" as const,
      amount:      e.amount,
      status:      e.status,
      network:     "Arc Platform",
      txHash:      e.txHash ?? null,
      fromAddress: e.senderAddress,
      toAddress:   e.recipientEmail,
      description: `Received from ${e.senderAddress}`,
      createdAt:   e.createdAt,
      completedAt: e.claimedAt ?? null,
    }));

    // ── Merge and sort all entries by date descending ─────────────────────────
    const all = [
      ...depositEntries,
      ...withdrawalEntries,
      ...sentEntries,
      ...receivedEntries,
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ transactions: all, total: all.length });
  } catch (error: any) {
    req.log.error({ err: error }, "[user/history] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
