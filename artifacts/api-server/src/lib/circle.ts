import axios from "axios";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const CIRCLE_API_KEY       = process.env.CIRCLE_API_KEY!;
const CIRCLE_API_BASE_URL  = process.env.CIRCLE_API_BASE_URL || "https://api-sandbox.circle.com";
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
let   CIRCLE_WALLET_SET_ID = process.env.CIRCLE_WALLET_SET_ID;

// ─── Supported blockchains ────────────────────────────────────────────────────
// Platform supports BASE-SEPOLIA only.

export const SUPPORTED_BLOCKCHAINS = ["BASE-SEPOLIA"] as const;
export type  SupportedBlockchain   = (typeof SUPPORTED_BLOCKCHAINS)[number];

export const PRIMARY_BLOCKCHAIN   = "BASE-SEPOLIA" as SupportedBlockchain;
export const PRIMARY_USDC_ADDRESS = process.env.BASE_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Fallback USDC token IDs — entity-specific, confirmed live via getWalletTokenBalance.
const FALLBACK_USDC_TOKEN_IDS: Record<string, string> = {
  "MATIC-AMOY":   "36b6931a-873a-56a8-8a27-b706b17104ee",
  "ETH-SEPOLIA":  "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
  "BASE-SEPOLIA": "bdf128b4-827b-5267-8f9e-243694989b5f",
};


// Per-wallet token-ID cache to avoid repeated API calls
const _tokenIdCache = new Map<string, string>(); // walletId → USDC token ID

// ─── Gas Station ──────────────────────────────────────────────────────────────
// Gas Station is NOT active on this entity (GET /v1/w3s/config/entity/gasStation → 404).
// 404 means the policy has not been configured — it is NOT auto-provisioned.
// The platform wallet (which holds ETH for gas) must be the source of all transfers.
// User wallets hold deposited USDC but have no ETH, so they cannot pay gas fees.

let _gasStationStatus: "enabled" | "disabled" | "unknown" = "disabled";

export function isGasStationEnabled(): boolean {
  return _gasStationStatus === "enabled";
}

export async function probeGasStationStatus(): Promise<void> {
  try {
    const res = await circleHttpClient.get("/v1/w3s/config/entity/gasStation", {
      validateStatus: () => true,
    });
    if (res.status === 200) {
      const enabled = res.data?.data?.enabled ?? res.data?.enabled;
      _gasStationStatus = enabled ? "enabled" : "disabled";
    } else {
      // 404 or any other status = not configured → disabled
      _gasStationStatus = "disabled";
    }
  } catch {
    _gasStationStatus = "disabled";
  }
  console.info(`[Circle] Gas Station: ${_gasStationStatus}`);
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

const circleHttpClient = axios.create({
  baseURL: CIRCLE_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${CIRCLE_API_KEY}`,
    "Content-Type": "application/json",
  },
});

// ─── DCW client singleton ─────────────────────────────────────────────────────

let _dcwClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

function getDcwClient() {
  if (!CIRCLE_ENTITY_SECRET) return null;
  if (!_dcwClient) {
    _dcwClient = initiateDeveloperControlledWalletsClient({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
      // Do NOT set baseUrl. Circle routes TEST_API_KEY requests to sandbox
      // automatically through api.circle.com. api-sandbox.circle.com returns 401.
    });
  }
  return _dcwClient;
}

async function ensureWalletSet(): Promise<string | null> {
  if (CIRCLE_WALLET_SET_ID) return CIRCLE_WALLET_SET_ID;
  const client = getDcwClient();
  if (!client) return null;

  try {
    const res = await client.createWalletSet({ name: "USDC App User Wallets" });
    const id = (res.data as any)?.walletSet?.id || (res as any)?.walletSet?.id;
    if (id) {
      CIRCLE_WALLET_SET_ID = id;
      return id;
    }
  } catch (e: any) {
    console.warn("[Circle DCW] Could not create wallet set:", e?.message || e);
  }
  return null;
}

// ─── User wallet creation ─────────────────────────────────────────────────────
// Creates a single Circle DCW wallet on BASE-SEPOLIA for the user.
// Returns: walletId, address, walletIdsJson (single-entry map for compat).

export async function createUserCircleWallet(_userId: number): Promise<{
  walletId: string;
  address: string;
  walletIdsJson: string;
}> {
  const client      = getDcwClient();
  const walletSetId = await ensureWalletSet();

  if (!client || !walletSetId) {
    throw new Error(
      "Circle DCW is not configured. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_SET_ID.",
    );
  }

  // SCA (Smart Contract Account) wallets are required for Gas Station sponsorship.
  // EOA wallets need native ETH for every transaction; SCA wallets do not.
  const res = await client.createWallets({
    blockchains:  ["BASE-SEPOLIA"] as any[],
    count:        1,
    walletSetId,
    accountType:  "SCA" as any,
    idempotencyKey: randomUUID(),
  });
  const wallets: any[] = (res.data as any)?.wallets ?? (res as any)?.wallets ?? [];

  if (wallets.length === 0 || !wallets[0]?.address) {
    throw new Error("Circle DCW createWallets returned no wallet — check API credentials and wallet set.");
  }

  const wallet = wallets[0];
  const walletId = wallet.id as string;
  const address  = wallet.address as string;
  return { walletId, address, walletIdsJson: JSON.stringify({ "BASE-SEPOLIA": walletId }) };
}

// ─── USDC balance + token ID resolution ──────────────────────────────────────

function isUsdcToken(b: any): boolean {
  return (
    b.token?.symbol?.toUpperCase() === "USDC" ||
    (b.token?.name ?? "").toLowerCase().includes("usd coin")
  );
}

export async function getWalletUsdcBalance(walletId: string): Promise<string> {
  const client = getDcwClient();
  if (!client) return "0";

  try {
    const res = await client.getWalletTokenBalance({ id: walletId });
    const tokenBalances: any[] = (res.data as any)?.tokenBalances ?? [];
    const usdcEntry = tokenBalances.find(isUsdcToken);
    // Cache the token ID while we're here
    if (usdcEntry?.token?.id) _tokenIdCache.set(walletId, usdcEntry.token.id);
    return usdcEntry?.amount ?? "0";
  } catch (e: any) {
    console.warn("[Circle DCW] getWalletUsdcBalance error:", e?.message);
    return "0";
  }
}

// Resolves the USDC token ID for a wallet by inspecting its token balances.
// Caches per walletId. Falls back to the hardcoded map when the wallet has
// never held USDC (e.g. freshly created platform wallet).
async function resolveUsdcTokenId(walletId: string, blockchain: string): Promise<string> {
  if (_tokenIdCache.has(walletId)) {
    const cached = _tokenIdCache.get(walletId)!;
    console.info(`[Circle] resolveUsdcTokenId: cache hit walletId=${walletId} tokenId=${cached}`);
    return cached;
  }

  const client = getDcwClient();
  if (client) {
    try {
      const res = await client.getWalletTokenBalance({ id: walletId });
      const tokenBalances: any[] = (res.data as any)?.tokenBalances ?? [];
      console.info(`[Circle] resolveUsdcTokenId: wallet ${walletId} has ${tokenBalances.length} token(s):`,
        tokenBalances.map(b => `${b.token?.symbol}=${b.token?.id}`).join(", ") || "(none)");
      const usdcEntry = tokenBalances.find(isUsdcToken);
      if (usdcEntry?.token?.id) {
        _tokenIdCache.set(walletId, usdcEntry.token.id);
        return usdcEntry.token.id;
      }
      console.warn(`[Circle] resolveUsdcTokenId: no USDC found in wallet ${walletId} — using fallback`);
    } catch (e: any) {
      console.warn(`[Circle] resolveUsdcTokenId: getWalletTokenBalance failed for ${walletId}:`, e?.message);
    }
  }

  const fallback = FALLBACK_USDC_TOKEN_IDS[blockchain] ?? FALLBACK_USDC_TOKEN_IDS["MATIC-AMOY"];
  console.info(`[Circle] resolveUsdcTokenId: using fallback tokenId=${fallback} for blockchain=${blockchain}`);
  return fallback;
}

// ─── USDC transfer via Circle DCW ────────────────────────────────────────────
// Sends USDC from a Circle DCW wallet to any EVM address on the specified chain.
//
// feeLevel: "MEDIUM" is always required by the Circle API regardless of wallet type.
// SCA wallets handle gas via EIP-4337 account abstraction — no native ETH needed.
// EOA wallets use their native ETH balance to pay gas at the specified fee level.

export async function circleTransferUsdc(
  fromWalletAddress: string,
  toAddress: string,
  blockchain: string,
  _tokenAddress: string,   // kept for call-site compat
  amount: string,
): Promise<string> {
  const client = getDcwClient();
  if (!client) {
    throw new Error("Circle DCW client not available — CIRCLE_ENTITY_SECRET not set");
  }

  const walletId = await resolveWalletIdForChain(fromWalletAddress, blockchain);
  if (!walletId) {
    throw new Error(`Could not resolve Circle walletId for address ${fromWalletAddress} on ${blockchain}`);
  }

  const tokenId = await resolveUsdcTokenId(walletId, blockchain);
  console.info(`[Circle] transfer: walletId=${walletId} tokenId=${tokenId} blockchain=${blockchain} amount=${amount}`);

  // feeLevel is always required by the Circle API.
  // SCA wallets pay gas via EIP-4337 (no native ETH needed); EOA wallets use their ETH balance.
  const input: any = {
    walletId,
    tokenId,
    destinationAddress: toAddress,
    amount: [amount],
    fee: { config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  };

  console.info("[Circle] createTransaction input:", JSON.stringify({ walletId, tokenId, destinationAddress: toAddress, amount, blockchain }));

  try {
    const res = await client.createTransaction(input);
    // SDK v10 wraps the Circle API response: res.data = { data: { id, state } }
    // Also handle older shapes: res.data.transaction.id or res.transaction.id
    const body = res.data as any;
    const txId: string | undefined =
      body?.data?.id          ??   // { data: { id } }  ← SDK v10
      body?.transaction?.id   ??   // { transaction: { id } }
      body?.id                ??   // { id } directly
      (res as any)?.transaction?.id;

    if (!txId) {
      // Log the actual response so we can diagnose future shape changes
      console.error("[Circle] Unexpected createTransaction response:", JSON.stringify(body));
      throw new Error("Circle createTransaction returned no transaction ID");
    }
    return txId;
  } catch (e: any) {
    console.error("[Circle] createTransaction error:", JSON.stringify({
      message: e?.message,
      errors: e?.errors,
      responseData: e?.response?.data,
      status: e?.response?.status,
    }));
    const apiMsg: string =
      e?.response?.data?.message ??
      e?.response?.data?.error?.message ??
      e?.errors?.[0]?.message ??
      e?.data?.message ??
      e?.message ??
      "Circle transfer failed";
    throw new Error(`Circle transfer error: ${apiMsg}`);
  }
}

// ─── Wallet ID resolution ─────────────────────────────────────────────────────
// Resolves the Circle wallet ID for a given on-chain address + blockchain.
// Checks platform wallets first, then user wallets (via circleWalletIdsJson).

// Cache for wallet IDs recovered from the Circle API — avoids repeated API calls
// for users whose circleWalletIdsJson was null (created before multi-chain support).
const _recoveredWalletIdCache = new Map<string, string>(); // `${address}:${blockchain}` → walletId

/**
 * Query the Circle API to find the wallet ID for a given address + blockchain.
 * Used as a one-time recovery path for users missing circleWalletIdsJson.
 * Writes the result back to the DB so future sweeps don't need the API call.
 */
async function recoverWalletIdFromCircle(
  walletAddress: string,
  blockchain: string,
): Promise<string | null> {
  const cacheKey = `${walletAddress.toLowerCase()}:${blockchain}`;
  if (_recoveredWalletIdCache.has(cacheKey)) {
    return _recoveredWalletIdCache.get(cacheKey)!;
  }

  const client = getDcwClient();
  if (!client || !CIRCLE_WALLET_SET_ID) return null;

  try {
    // List wallets in the wallet set filtered by blockchain, then match by address
    const res = await client.listWallets({
      walletSetId: CIRCLE_WALLET_SET_ID,
      blockchain: blockchain as any,
      pageSize: 50,
    });
    const wallets: any[] = (res.data as any)?.wallets ?? (res as any)?.wallets ?? [];
    const match = wallets.find(
      (w: any) => w.address?.toLowerCase() === walletAddress.toLowerCase(),
    );

    if (!match?.id) return null;

    _recoveredWalletIdCache.set(cacheKey, match.id);
    console.info(`[Circle] Recovered walletId ${match.id} for ${walletAddress} on ${blockchain}`);

    // Backfill circleWalletIdsJson in the DB so this lookup never happens again
    try {
      const { db, usersTable } = await import("@workspace/db");
      const { sql, eq } = await import("drizzle-orm");
      const [user] = await db
        .select({ id: usersTable.id, circleWalletIdsJson: (usersTable as any).circleWalletIdsJson })
        .from(usersTable)
        .where(sql`lower(${usersTable.circleWalletAddress}) = lower(${walletAddress})`)
        .limit(1);

      if (user) {
        const existing = user.circleWalletIdsJson
          ? JSON.parse(user.circleWalletIdsJson) as Record<string, string>
          : {};
        existing[blockchain] = match.id;
        await db
          .update(usersTable)
          .set({ circleWalletIdsJson: JSON.stringify(existing) } as any)
          .where(eq(usersTable.id, user.id));
        console.info(`[Circle] Backfilled circleWalletIdsJson for user ${user.id} (${blockchain})`);
      }
    } catch (e: any) {
      console.warn(`[Circle] DB backfill failed for ${walletAddress}:`, e?.message);
    }

    return match.id;
  } catch (e: any) {
    console.warn(`[Circle] recoverWalletIdFromCircle failed for ${walletAddress} on ${blockchain}:`, e?.message);
    return null;
  }
}

async function resolveWalletIdForChain(
  walletAddress: string,
  blockchain: string,
): Promise<string | null> {
  // 1. Check if it's the platform wallet
  const platformAddress = getPlatformWalletAddress();
  if (platformAddress?.toLowerCase() === walletAddress.toLowerCase()) {
    return getPlatformWalletIdForChain(blockchain);
  }

  // 2. Look up user wallet — prefer per-chain map, fall back to circleWalletId
  try {
    const { db, usersTable } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const [user] = await db
      .select({
        id:                  usersTable.id,
        circleWalletId:      usersTable.circleWalletId,
        circleWalletIdsJson: (usersTable as any).circleWalletIdsJson,
      })
      .from(usersTable)
      .where(
        sql`lower(${usersTable.circleWalletAddress}) = lower(${walletAddress})`,
      )
      .limit(1);

    if (!user) return null;

    // Fast path — per-chain map is populated
    if (user.circleWalletIdsJson) {
      const idsMap = JSON.parse(user.circleWalletIdsJson) as Record<string, string>;
      if (idsMap[blockchain]) return idsMap[blockchain];
    }

    // Fallback — circleWalletId is only valid for the primary chain.
    // For any other chain, query Circle API to recover the correct wallet ID.
    if (blockchain === PRIMARY_BLOCKCHAIN) {
      return user.circleWalletId ?? null;
    }

    // Recovery path: look up the wallet ID from Circle API and backfill DB
    const recovered = await recoverWalletIdFromCircle(walletAddress, blockchain);
    return recovered ?? null;
  } catch {
    return null;
  }
}

// ─── Platform wallet helpers ──────────────────────────────────────────────────

/** Returns the Circle wallet ID for the platform treasury on a specific chain. */
export function getPlatformWalletIdForChain(blockchain: string): string | null {
  const envKey = `CIRCLE_PLATFORM_WALLET_ID_${blockchain.replace(/-/g, "_")}`;
  return process.env[envKey] ?? process.env.CIRCLE_PLATFORM_WALLET_ID ?? null;
}

/** Returns the Circle wallet ID for the platform treasury on the primary chain. */
export function getPlatformWalletId(): string | null {
  return getPlatformWalletIdForChain(PRIMARY_BLOCKCHAIN);
}

/** Returns the shared on-chain address of the platform treasury wallet. */
export function getPlatformWalletAddress(): string | null {
  return process.env.CIRCLE_PLATFORM_WALLET_ADDRESS ?? null;
}

// ─── Fiat bank transfer helpers ───────────────────────────────────────────────

export interface BankDetails {
  bankAccountNumber: string;
  routingNumber: string;
  accountHolderName: string;
  country: string;
}

export async function initiateWireTransfer(
  amount: string,
  bankDetails: BankDetails,
): Promise<{ transferId: string; status: string }> {
  const idempotencyKey = randomUUID();

  try {
    const bankAccountResponse = await circleHttpClient.post("/v1/banks/wires", {
      idempotencyKey: `bank-${idempotencyKey}`,
      accountNumber: bankDetails.bankAccountNumber,
      routingNumber: bankDetails.routingNumber,
      billingDetails: {
        name: bankDetails.accountHolderName,
        country: bankDetails.country,
        city: "N/A",
        line1: "N/A",
        district: "N/A",
        postalCode: "00000",
      },
      bankAddress: { country: bankDetails.country },
    });

    const bankId = bankAccountResponse.data.data.id;

    const payoutResponse = await circleHttpClient.post("/v1/payouts", {
      idempotencyKey,
      source: { type: "wallet", id: process.env.CIRCLE_MASTER_WALLET_ID || "1000216185" },
      destination: { type: "wire", id: bankId },
      amount: { amount, currency: "USD" },
    });

    return {
      transferId: payoutResponse.data.data.id,
      status: payoutResponse.data.data.status,
    };
  } catch (error: any) {
    if (CIRCLE_API_BASE_URL.includes("sandbox")) {
      return { transferId: randomUUID(), status: "pending" };
    }
    throw new Error(`Circle API error: ${error.response?.data?.message || error.message}`);
  }
}

export async function getPayoutStatus(payoutId: string): Promise<string> {
  try {
    const response = await circleHttpClient.get(`/v1/payouts/${payoutId}`);
    return response.data.data.status;
  } catch (error: any) {
    throw new Error(`Failed to get payout status: ${error.message}`);
  }
}

export interface AchDepositResult {
  paymentId: string;
  bankId: string;
  status: string;
}

export async function initiateAchDeposit(
  amount: string,
  bankDetails: BankDetails,
  _idempotencyRef: string,
): Promise<AchDepositResult> {
  const idempotencyKey = randomUUID();

  try {
    const bankRes = await circleHttpClient.post("/v1/banks/ach", {
      idempotencyKey: `bank-ach-${idempotencyKey}`,
      accountNumber: bankDetails.bankAccountNumber,
      routingNumber: bankDetails.routingNumber,
      billingDetails: {
        name: bankDetails.accountHolderName,
        country: bankDetails.country,
        city: "N/A",
        line1: "N/A",
        district: "N/A",
        postalCode: "00000",
      },
    });

    const bankId: string = bankRes.data.data.id;

    const paymentRes = await circleHttpClient.post("/v1/payments", {
      idempotencyKey,
      amount: { amount, currency: "USD" },
      source: { id: bankId, type: "ach" },
      description: "Arc Fintech deposit",
      metadata: { email: bankDetails.accountHolderName },
    });

    const payment = paymentRes.data.data;
    return { paymentId: payment.id, bankId, status: payment.status };
  } catch (error: any) {
    if (CIRCLE_API_BASE_URL.includes("sandbox")) {
      return {
        paymentId: randomUUID(),
        bankId: randomUUID(),
        status: "pending",
      };
    }
    throw new Error(`Circle ACH deposit error: ${error.response?.data?.message || error.message}`);
  }
}

// ─── Circle wire bank deposit ─────────────────────────────────────────────────

/**
 * Creates a Circle wire bank account resource for a specific user.
 * Circle assigns a unique trackingRef — the user includes this in their wire
 * transfer reference field so Circle (and we) can identify which user sent funds.
 *
 * Sandbox note: bank account details are not verified, so placeholder values work.
 */
export async function createCircleWireBankAccount(userId: number): Promise<{
  id: string;
  trackingRef: string;
  status: string;
}> {
  const res = await circleHttpClient.post("/v1/businessAccount/banks/wires", {
    idempotencyKey: randomUUID(),
    // Placeholder US bank details — Circle sandbox does not verify these.
    accountNumber: `1000${userId.toString().padStart(8, "0")}`,
    routingNumber: "121000248", // Wells Fargo ABA
    billingDetails: {
      name: `ARC Finance User ${userId}`,
      city: "San Francisco",
      country: "US",
      line1: "1 Market St",
      district: "CA",
      postalCode: "94105",
    },
    bankAddress: {
      bankName: "Wells Fargo Bank",
      city: "San Francisco",
      country: "US",
    },
  });
  const data = res.data?.data ?? res.data;
  return { id: data.id, trackingRef: data.trackingRef, status: data.status };
}

/**
 * Fetches Circle's wire deposit instructions for a given wire bank account ID.
 * Returns Circle's bank details (routing, account, SWIFT, beneficiary name).
 * Users send their wire TO these details and include their trackingRef as the reference.
 */
export async function getCircleWireDepositInstructions(wireAccountId: string): Promise<{
  trackingRef: string;
  beneficiary: { name: string; address1: string; address2: string };
  beneficiaryBank: {
    name: string;
    swiftCode: string;
    routingNumber: string;
    accountNumber: string;
    currency: string;
    address: string;
    city: string;
    postalCode: string;
    country: string;
  };
}> {
  const res = await circleHttpClient.get(`/v1/businessAccount/banks/wires/${wireAccountId}/instructions`);
  return res.data?.data ?? res.data;
}

/**
 * Sandbox only: simulate an inbound wire payment.
 * Circle processes mock wire deposits in batches — credit may take up to 15 minutes.
 */
export async function createMockWireDeposit(
  trackingRef: string,
  circleAccountNumber: string,
  amountUsd: string,
): Promise<void> {
  await circleHttpClient.post("/v1/mocks/payments/wire", {
    trackingRef,
    amount: { amount: amountUsd, currency: "USD" },
    beneficiaryBank: { accountNumber: circleAccountNumber },
  });
}

// ─── Circle webhook subscription ─────────────────────────────────────────────

export async function ensureCircleWebhookSubscription(webhookUrl: string): Promise<void> {
  try {
    const listRes = await circleHttpClient.get("/v1/notifications/subscriptions");
    const existing: any[] = listRes.data?.data ?? [];
    const alreadyRegistered = existing.some((s: any) => s.endpoint === webhookUrl);

    if (alreadyRegistered) {
      console.info(`[Circle] Webhook already registered: ${webhookUrl}`);
      return;
    }

    await circleHttpClient.post("/v1/notifications/subscriptions", { endpoint: webhookUrl });
    console.info(`[Circle] Webhook subscription registered: ${webhookUrl}`);
  } catch (err: any) {
    console.warn(`[Circle] Could not register webhook subscription: ${err?.response?.data?.message ?? err?.message}`);
  }
}
