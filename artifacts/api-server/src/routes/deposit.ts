import { Router, type IRouter } from "express";
import { db, usersTable, depositsTable, virtualAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  createCircleWireBankAccount,
  getCircleWireDepositInstructions,
  createMockWireDeposit,
  circleTransferUsdc,
  getPlatformWalletAddress,
  PRIMARY_USDC_ADDRESS,
  type SupportedBlockchain,
} from "../lib/circle.js";

const CIRCLE_CHAIN_MAP: Record<string, SupportedBlockchain> = {
  "BASE-SEPOLIA": "BASE-SEPOLIA",
};

const router: IRouter = Router();

// ─── GET /api/deposit/wire/instructions ──────────────────────────────────────
// Returns Circle's wire deposit instructions for the authenticated user.
// Creates a unique wire bank account (and tracking reference) on first call,
// then reuses it on subsequent calls.
router.get("/wire/instructions", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;

    // Reuse existing wire account if already created for this user
    const [existing] = await db
      .select()
      .from(virtualAccountsTable)
      .where(and(
        eq(virtualAccountsTable.userId, user.userId),
        eq(virtualAccountsTable.provider, "circle-wire"),
      ))
      .limit(1);

    let wireAccountId: string;
    let trackingRef: string;

    if (existing) {
      wireAccountId = existing.providerRef!;
      trackingRef   = existing.accountNumber; // accountNumber stores trackingRef
    } else {
      // First time — create a wire bank account for this user
      const wire = await createCircleWireBankAccount(user.userId);
      wireAccountId = wire.id;
      trackingRef   = wire.trackingRef;

      await db.insert(virtualAccountsTable).values({
        userId:        user.userId,
        provider:      "circle-wire",
        accountNumber: trackingRef,         // unique ref user includes in wire memo
        accountName:   "ARC Finance",
        bankName:      "Circle / JPMorgan Chase",
        bankCode:      null,
        providerRef:   wireAccountId,       // Circle wire bank account ID
        currency:      "USD",
      });

      req.log.info({ userId: user.userId, trackingRef, wireAccountId }, "[deposit] Circle wire account created");
    }

    // Always fetch fresh instructions from Circle (bank details may change)
    const instructions = await getCircleWireDepositInstructions(wireAccountId);

    res.json({
      trackingRef,
      beneficiary:     instructions.beneficiary,
      beneficiaryBank: instructions.beneficiaryBank,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[deposit] Wire instructions error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/deposit/wire/mock ──────────────────────────────────────────────
// Sandbox only: simulate an incoming wire payment for the authenticated user.
// Body: { amount: "100.00" }
router.post("/wire/mock", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const { amount } = req.body;

    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Provide a positive USD amount" });
      return;
    }

    const [wireAccount] = await db
      .select()
      .from(virtualAccountsTable)
      .where(and(
        eq(virtualAccountsTable.userId, user.userId),
        eq(virtualAccountsTable.provider, "circle-wire"),
      ))
      .limit(1);

    if (!wireAccount) {
      res.status(400).json({ error: "No wire account", message: "Load wire instructions first to create your deposit account" });
      return;
    }

    const instructions = await getCircleWireDepositInstructions(wireAccount.providerRef!);

    await createMockWireDeposit(
      wireAccount.accountNumber,                    // trackingRef
      instructions.beneficiaryBank.accountNumber,   // Circle's account number
      parseFloat(amount).toFixed(2),
    );

    req.log.info({ userId: user.userId, amount }, "[deposit] Mock wire deposit initiated");
    res.json({
      message:   "Mock wire deposit submitted. Circle processes in batches — your balance will be credited within 15 minutes.",
      amount:    parseFloat(amount).toFixed(2),
      currency:  "USD",
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[deposit] Mock wire error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/deposit/circle/webhook ────────────────────────────────────────
// Handles two event types from Circle:
//   1. "payments"            — wire (fiat) deposits credited to the Circle account
//   2. "transactions.inbound"— USDC on-chain deposits to a user's Circle DCW wallet
router.post("/circle/webhook", async (req, res) => {
  // Always respond 200 immediately — Circle retries if no 200 within 5 s
  res.status(200).json({ received: true });

  try {
    const { notificationType, notification } = req.body ?? {};
    console.info(`[circle/webhook] notificationType=${notificationType} body=${JSON.stringify(req.body).slice(0, 400)}`);

    // ── Wire (fiat) payment ───────────────────────────────────────────────────
    if (notificationType === "payments") {
      const payment = notification?.payment ?? notification;
      if (!payment) return;

      const { id: paymentId, type, status, trackingRef, amount } = payment;
      console.info(`[circle/webhook] Payment: type=${type} status=${status} trackingRef=${trackingRef} amount=${JSON.stringify(amount)}`);

      if (type !== "wire" || status !== "paid") return;
      if (!trackingRef || !amount?.amount) return;

      const amountUsd = parseFloat(amount.amount);
      if (amountUsd <= 0) return;

      // Idempotency — skip if we already credited this payment
      if (paymentId) {
        const [dup] = await db
          .select({ id: depositsTable.id })
          .from(depositsTable)
          .where(eq(depositsTable.depositReference, paymentId))
          .limit(1);
        if (dup) return;
      }

      // Resolve user by their unique trackingRef
      const [wireAccount] = await db
        .select({ userId: virtualAccountsTable.userId })
        .from(virtualAccountsTable)
        .where(and(
          eq(virtualAccountsTable.provider, "circle-wire"),
          eq(virtualAccountsTable.accountNumber, trackingRef),
        ))
        .limit(1);

      if (!wireAccount) {
        console.warn(`[circle/webhook] No wire account found for trackingRef=${trackingRef}`);
        return;
      }

      const [dbUser] = await db
        .select({ claimedBalance: usersTable.claimedBalance })
        .from(usersTable)
        .where(eq(usersTable.id, wireAccount.userId))
        .limit(1);

      const newBalance = (parseFloat(dbUser?.claimedBalance ?? "0") + amountUsd).toFixed(6);
      await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, wireAccount.userId));

      await db.insert(depositsTable).values({
        userId:           wireAccount.userId,
        amount:           amountUsd.toFixed(6),
        type:             "bank",
        source:           "Circle Wire Transfer",
        status:           "completed",
        depositReference: paymentId ?? trackingRef,
        creditedAt:       new Date(),
      });

      console.info(`[circle/webhook] Credited $${amountUsd} USD wire deposit to user ${wireAccount.userId}`);
      return;
    }

    // ── USDC on-chain inbound ─────────────────────────────────────────────────
    if (notificationType !== "transactions.inbound") return;
    if (!notification) return;

    const { id: txId, walletId, amounts, blockchain, txHash, state, destinationAddress } = notification;
    console.info(`[circle/webhook] Inbound: state=${state} walletId=${walletId} address=${destinationAddress} amount=${amounts?.[0]} chain=${blockchain}`);

    if (state !== "COMPLETED") return;
    if (!amounts?.length) return;

    const amount = String(amounts[0] ?? "0");
    if (!amount || parseFloat(amount) <= 0) return;

    let dbUser: { id: number; claimedBalance: string } | undefined;

    if (walletId) {
      const [byWalletId] = await db
        .select({ id: usersTable.id, claimedBalance: usersTable.claimedBalance })
        .from(usersTable)
        .where(eq(usersTable.circleWalletId, walletId))
        .limit(1);
      dbUser = byWalletId;
    }

    if (!dbUser && destinationAddress) {
      const { sql } = await import("drizzle-orm");
      const [byAddress] = await db
        .select({ id: usersTable.id, claimedBalance: usersTable.claimedBalance })
        .from(usersTable)
        .where(sql`lower(${usersTable.circleWalletAddress}) = lower(${destinationAddress})`)
        .limit(1);
      dbUser = byAddress;
    }

    if (!dbUser) {
      console.warn(`[circle/webhook] No user for walletId=${walletId} address=${destinationAddress}`);
      return;
    }

    const idempotencyRef = txId ?? txHash ?? "";
    if (idempotencyRef) {
      const existing = await db
        .select({ id: depositsTable.id })
        .from(depositsTable)
        .where(eq(depositsTable.depositReference, idempotencyRef))
        .limit(1);
      if (existing.length > 0) return;
    }

    const newBalance = (parseFloat(dbUser.claimedBalance ?? "0") + parseFloat(amount)).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, dbUser.id));

    await db.insert(depositsTable).values({
      userId:           dbUser.id,
      amount:           parseFloat(amount).toFixed(6),
      type:             "crypto",
      source:           `${blockchain ?? "Circle"} USDC`,
      status:           "completed",
      depositReference: idempotencyRef || null,
      txHash:           txHash ?? null,
      creditedAt:       new Date(),
    });

    console.info(`[circle/webhook] Credited ${amount} USDC to user ${dbUser.id} from ${blockchain} (id: ${txId})`);

    // Sweep on-chain USDC deposits to the platform treasury
    const circleChain = blockchain ? CIRCLE_CHAIN_MAP[blockchain.toUpperCase()] : undefined;
    if (circleChain && destinationAddress) {
      const platformAddress = getPlatformWalletAddress();
      if (platformAddress && destinationAddress.toLowerCase() !== platformAddress.toLowerCase()) {
        circleTransferUsdc(destinationAddress, platformAddress, circleChain, PRIMARY_USDC_ADDRESS, parseFloat(amount).toFixed(6))
          .then(() => console.info(`[circle/webhook] Swept ${amount} USDC to ${circleChain} treasury`))
          .catch((e: any) => console.warn(`[circle/webhook] Sweep failed: ${e?.message}`));
      }
    }
  } catch (err: any) {
    console.error("[circle/webhook] Error:", err?.message);
  }
});

// ─── GET /api/deposit/history ─────────────────────────────────────────────────
router.get("/history", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const deposits = await db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.userId, user.userId))
      .orderBy(depositsTable.createdAt);
    res.json({ deposits: deposits.reverse() });
  } catch (error: any) {
    req.log.error({ err: error }, "[deposit] History error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
