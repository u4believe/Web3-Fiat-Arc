import { Router, type IRouter } from "express";
import { db, usersTable, depositsTable, virtualAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { getNgnToUsdRate, ngnToUsd } from "../lib/fx.js";
import {
  createPaystackVirtualAccount,
  verifyPaystackSignature,
  parsePaystackCharge,
} from "../lib/paystack.js";
import crypto from "crypto";

const router: IRouter = Router();

// ─── Shared: credit a user's balance and record the deposit ─────────────────
async function creditDeposit(
  userId: number,
  amountNgn: number,
  provider: string,
  providerTxRef: string,
  logger: (...args: any[]) => void,
) {
  const rate      = await getNgnToUsdRate();
  const amountUsd = ngnToUsd(amountNgn, rate);

  const [dbUser] = await db
    .select({ claimedBalance: usersTable.claimedBalance })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  const newBalance = (parseFloat(dbUser?.claimedBalance ?? "0") + amountUsd).toFixed(6);

  await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, userId));

  await db.insert(depositsTable).values({
    userId,
    amount: amountUsd.toFixed(6),
    type: "bank",
    source: provider,
    status: "completed",
    depositReference: providerTxRef,
    circlePaymentId:  providerTxRef,
    creditedAt: new Date(),
  });

  logger({ userId, amountNgn, amountUsd, provider, providerTxRef }, `[deposit/webhook] ${provider} deposit credited`);
}

// ─── GET /api/deposit/bank/virtual-accounts ──────────────────────────────────
router.get("/bank/virtual-accounts", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const accounts = await db
      .select()
      .from(virtualAccountsTable)
      .where(eq(virtualAccountsTable.userId, user.userId));
    res.json({ accounts });
  } catch (error: any) {
    req.log.error({ err: error }, "[deposit] Fetch virtual accounts error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/deposit/bank/virtual-account ───────────────────────────────────
// Body: { provider: "paystack" }
router.post("/bank/virtual-account", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const { provider } = req.body;

    if (provider !== "paystack") {
      res.status(400).json({ error: "Invalid provider", message: "Only paystack is supported" });
      return;
    }

    // Return existing account if already generated
    const [existing] = await db
      .select()
      .from(virtualAccountsTable)
      .where(and(
        eq(virtualAccountsTable.userId, user.userId),
        eq(virtualAccountsTable.provider, provider),
      ))
      .limit(1);

    if (existing) {
      res.json({ account: existing, created: false });
      return;
    }

    const [dbUser] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, user.userId))
      .limit(1);

    const email = dbUser?.email ?? user.email;
    const name  = dbUser?.name  ?? "Arc User";

    const result = await createPaystackVirtualAccount(user.userId, email, name);

    const [inserted] = await db
      .insert(virtualAccountsTable)
      .values({
        userId:        user.userId,
        provider:      "paystack",
        accountNumber: result.accountNumber,
        accountName:   result.accountName,
        bankName:      result.bankName,
        bankCode:      result.bankCode,
        providerRef:   result.customerCode,
        currency:      "NGN",
      })
      .returning();

    req.log.info({ accountNumber: inserted.accountNumber, userId: user.userId }, "[deposit] Paystack virtual account created");
    res.json({ account: inserted, created: true });
  } catch (error: any) {
    req.log.error({ err: error }, "[deposit] Virtual account creation error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/deposit/paystack/webhook ──────────────────────────────────────
// Paystack fires "charge.success" when funds land on a dedicated virtual account.
// Verified via x-paystack-signature (HMAC-SHA512 of raw body).
router.post("/paystack/webhook", async (req, res) => {
  const rawBody   = (req as any).rawBody as Buffer | undefined;
  const sigHeader = String(req.headers["x-paystack-signature"] ?? "");

  if (!rawBody || !verifyPaystackSignature(rawBody, sigHeader)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  try {
    const event = parsePaystackCharge(req.body);
    if (!event || event.channel !== "dedicated_nuban") {
      res.status(200).json({ received: true });
      return;
    }

    const [dbUser] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, event.email))
      .limit(1);

    if (!dbUser) {
      console.warn({ email: event.email }, "[paystack/webhook] Unknown user");
      res.status(200).json({ received: true });
      return;
    }

    await creditDeposit(dbUser.id, event.amountNgn, "paystack", event.paystackRef, console.info);
    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error({ err: error }, "[paystack/webhook] Error");
    res.status(200).json({ received: true });
  }
});

// ─── POST /api/deposit/circle/webhook ────────────────────────────────────────
// Circle fires this when USDC lands in any user's Developer-Controlled Wallet.
// Supports all Circle-connected networks (Polygon Amoy, Ethereum, Base, etc.)
router.post("/circle/webhook", async (req, res) => {
  // Always respond 200 immediately so Circle doesn't retry
  res.status(200).json({ received: true });

  try {
    const { notificationType, notification } = req.body ?? {};

    // Only process confirmed inbound transfers
    if (notificationType !== "transactions.inbound") return;
    if (!notification) return;

    const { walletId, amounts, tokenId, blockchain, txHash, state } = notification;

    if (state !== "CONFIRMED") return;
    if (!walletId || !amounts?.length) return;

    // Verify it's a USDC transfer (token symbol check)
    const isUsdc =
      notification.token?.symbol?.toUpperCase().includes("USDC") ||
      notification.amounts?.[0] !== undefined; // fallback: accept any token if symbol unavailable

    if (!isUsdc) return;

    const amount = String(amounts[0] ?? notification.amount ?? "0");
    if (!amount || parseFloat(amount) <= 0) return;

    // Find the user whose Circle wallet received the funds
    const [dbUser] = await db
      .select({ id: usersTable.id, claimedBalance: usersTable.claimedBalance })
      .from(usersTable)
      .where(eq(usersTable.circleWalletId, walletId))
      .limit(1);

    if (!dbUser) {
      console.warn(`[circle/webhook] No user found for walletId=${walletId}`);
      return;
    }

    // Idempotency — skip if this tx was already credited
    const existing = await db
      .select({ id: depositsTable.id })
      .from(depositsTable)
      .where(eq(depositsTable.txHash, txHash ?? ""))
      .limit(1);

    if (existing.length > 0) return;

    const newBalance = (parseFloat(dbUser.claimedBalance ?? "0") + parseFloat(amount)).toFixed(6);

    await db.update(usersTable)
      .set({ claimedBalance: newBalance })
      .where(eq(usersTable.id, dbUser.id));

    await db.insert(depositsTable).values({
      userId: dbUser.id,
      amount: parseFloat(amount).toFixed(6),
      type: "crypto",
      source: `${blockchain ?? "Circle"} USDC`,
      status: "completed",
      txHash: txHash ?? null,
      creditedAt: new Date(),
    });

    console.info(`[circle/webhook] Credited ${amount} USDC to user ${dbUser.id} from ${blockchain} (tx: ${txHash})`);
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
