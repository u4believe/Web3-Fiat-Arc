import axios from "axios";
import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE_URL   = "https://api.paystack.co";

const paystackClient = axios.create({
  baseURL: PAYSTACK_BASE_URL,
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

export interface PaystackVirtualAccount {
  accountNumber: string;
  accountName:   string;
  bankName:      string;
  bankCode:      string;
  customerCode:  string; // stored as providerRef
}

// ─── Create or reuse a Paystack dedicated virtual account ─────────────────────
//
// Flow:
//   1. Create a Paystack Customer (idempotent — reuse existing customer_code)
//   2. Assign a Dedicated Virtual Account (DVA) to that customer
//
// Banks available (live): wema-bank, titan-paystack
// Bank available  (test): test-bank
export async function createPaystackVirtualAccount(
  userId: number,
  email: string,
  name: string,
): Promise<PaystackVirtualAccount> {
  // Step 1 — create Paystack customer (returns existing if email already registered)
  const customerRes = await paystackClient.post("/customer", {
    email,
    first_name: name.split(" ")[0] ?? name,
    last_name:  name.split(" ").slice(1).join(" ") || "User",
    metadata:   { arc_user_id: userId },
  });

  const customerCode: string = customerRes.data.data.customer_code;

  // Step 2 — assign a dedicated virtual account
  const preferredBank = process.env.PAYSTACK_PREFERRED_BANK || "test-bank"; // "wema-bank" in production
  const dvaRes = await paystackClient.post("/dedicated_account", {
    customer:       customerCode,
    preferred_bank: preferredBank,
  });

  const dva = dvaRes.data.data;

  return {
    accountNumber: dva.account_number,
    accountName:   dva.account_name,
    bankName:      dva.bank.name,
    bankCode:      String(dva.bank.id),
    customerCode,
  };
}

// ─── Webhook signature validation ────────────────────────────────────────────
// Paystack signs the raw body with HMAC-SHA512 using your secret key.
// Pass the raw body buffer from the request.
export function verifyPaystackSignature(rawBody: Buffer, signature: string): boolean {
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signature;
}

// ─── Register webhook URL with Paystack ──────────────────────────────────────
// Call once at server startup. Paystack stores one webhook URL per integration.
// WEBHOOK_URL should be the public base URL of your server, e.g. https://arcusdcpayment.com
export async function registerPaystackWebhook(): Promise<void> {
  const baseUrl = process.env.WEBHOOK_URL;
  if (!baseUrl) {
    console.warn("[paystack] WEBHOOK_URL not set — skipping webhook registration");
    return;
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/deposit/paystack/webhook`;

  try {
    await paystackClient.put("/integration/configuration", { webhook: webhookUrl });
    console.info({ webhookUrl }, "[paystack] Webhook URL registered");
  } catch (err: any) {
    // Non-fatal: some Paystack plans don't support programmatic registration.
    // In that case set it manually in the Paystack dashboard.
    console.warn({ err: err.response?.data?.message ?? err.message, webhookUrl }, "[paystack] Webhook registration failed — set it manually in the dashboard");
  }
}

// ─── Parse a Paystack charge.success webhook ─────────────────────────────────
// Returns the credited amount in NGN and the customer email.
export interface PaystackChargeEvent {
  email:          string;
  amountNgn:      number; // already in NGN (divided from kobo)
  channel:        string; // "dedicated_nuban" for virtual account transfers
  paystackRef:    string;
  accountNumber:  string; // the DVA that received funds
}

export function parsePaystackCharge(body: any): PaystackChargeEvent | null {
  if (body?.event !== "charge.success") return null;
  const data = body.data ?? {};
  return {
    email:         data.customer?.email ?? "",
    amountNgn:     (data.amount ?? 0) / 100, // kobo → NGN
    channel:       data.channel ?? "",
    paystackRef:   data.reference ?? "",
    accountNumber: data.authorization?.receiver_bank_account_number ?? "",
  };
}
