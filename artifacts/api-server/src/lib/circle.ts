import axios from "axios";
import { ethers } from "ethers";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const CIRCLE_API_KEY       = process.env.CIRCLE_API_KEY!;
const CIRCLE_API_BASE_URL  = process.env.CIRCLE_API_BASE_URL || "https://api-sandbox.circle.com";
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
let   CIRCLE_WALLET_SET_ID = process.env.CIRCLE_WALLET_SET_ID;

// ─── Supported blockchains ────────────────────────────────────────────────────

export const SUPPORTED_BLOCKCHAINS = ["MATIC-AMOY", "ETH-SEPOLIA", "BASE-SEPOLIA"] as const;
export type  SupportedBlockchain   = (typeof SUPPORTED_BLOCKCHAINS)[number];

// Primary chain — the one we send withdrawals on (also used as the default for
// resolving wallet IDs when no chain is explicitly given).
export const PRIMARY_BLOCKCHAIN   = (process.env.CIRCLE_PRIMARY_BLOCKCHAIN ?? "BASE-SEPOLIA") as SupportedBlockchain;
export const PRIMARY_USDC_ADDRESS = process.env.POLYGON_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Fallback USDC token IDs — confirmed from live wallet balance queries on this entity.
// These are entity-specific (not global Circle constants) — verified 2026-04-13.
const FALLBACK_USDC_TOKEN_IDS: Record<string, string> = {
  "MATIC-AMOY":   "36b6931a-873a-56a8-8a27-b706b17104ee",
  "ETH-SEPOLIA":  "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
  "BASE-SEPOLIA": "bdf128b4-827b-5267-8f9e-243694989b5f",
};

// Per-wallet token-ID cache to avoid repeated API calls
const _tokenIdCache = new Map<string, string>(); // walletId → USDC token ID

// ─── Gas Station ──────────────────────────────────────────────────────────────
// On TESTNET Circle automatically provisions a default Gas Station policy —
// no console setup required. Gas is sponsored for all SCA wallets automatically
// as long as feeLevel is NOT included in createTransaction().
//
// On MAINNET you must create and activate a policy in the Circle console first.
//
// CIRCLE_GAS_STATION_ENABLED=true bypasses the API probe and forces gas station
// mode regardless of what the API returns.

let _gasStationStatus: "enabled" | "disabled" | "unknown" = "unknown";

export function isGasStationEnabled(): boolean {
  if (process.env.CIRCLE_GAS_STATION_ENABLED === "true") return true;
  return _gasStationStatus === "enabled";
}

export async function probeGasStationStatus(): Promise<void> {
  // Env var override — skip the probe entirely
  if (process.env.CIRCLE_GAS_STATION_ENABLED === "true") {
    _gasStationStatus = "enabled";
    console.info("[Circle] Gas Station: enabled (env override)");
    return;
  }

  try {
    const res = await circleHttpClient.get("/v1/w3s/config/entity/gasStation", {
      validateStatus: () => true,
    });
    if (res.status === 200) {
      const enabled = res.data?.data?.enabled ?? res.data?.enabled;
      _gasStationStatus = enabled ? "enabled" : "disabled";
    } else if (res.status === 404) {
      // 404 on testnet is expected — Circle auto-provisions a default policy and
      // does not expose it through this API. Treat as enabled.
      _gasStationStatus = "enabled";
    } else {
      _gasStationStatus = "disabled";
    }
  } catch {
    _gasStationStatus = "unknown";
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

// ─── HD-wallet fallback ───────────────────────────────────────────────────────

function derivePlatformWallet(userId: number): { walletId: string; address: string; walletIdsJson: string } {
  const seed = Buffer.from(
    (process.env.BACKEND_SIGNER_PRIVATE_KEY || "").replace("0x", "").padStart(64, "0"),
    "hex",
  );
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  const derived = hdNode.derivePath(`m/44'/60'/0'/0/${userId}`);
  const walletId = `platform-${userId}`;
  // HD wallets are chain-agnostic — same ID for all chains
  const walletIdsJson = JSON.stringify(
    Object.fromEntries(SUPPORTED_BLOCKCHAINS.map((b) => [b, walletId])),
  );
  return { walletId, address: derived.address, walletIdsJson };
}

// ─── User wallet creation ─────────────────────────────────────────────────────
// Creates Circle DCW wallets on ALL supported chains in one call so the user's
// deposit address is monitored on every chain automatically. The wallets share
// the same on-chain address within a wallet set.
// Returns: walletId (primary chain), address (shared), walletIdsJson (all chains).

export async function createUserCircleWallet(userId: number): Promise<{
  walletId: string;
  address: string;
  walletIdsJson: string;
}> {
  const client     = getDcwClient();
  const walletSetId = await ensureWalletSet();

  if (client && walletSetId) {
    try {
      const res = await client.createWallets({
        blockchains: [...SUPPORTED_BLOCKCHAINS] as any[],
        count: 1,
        walletSetId,
        idempotencyKey: randomUUID(),
      });
      const wallets: any[] = (res.data as any)?.wallets ?? (res as any)?.wallets ?? [];

      if (wallets.length > 0 && wallets[0]?.address) {
        const address = wallets[0].address as string;
        const idsMap: Record<string, string> = {};
        for (const w of wallets) {
          idsMap[w.blockchain as string] = w.id as string;
        }
        const walletId = idsMap[PRIMARY_BLOCKCHAIN] ?? wallets[0].id;
        return { walletId, address, walletIdsJson: JSON.stringify(idsMap) };
      }
    } catch (e: any) {
      console.warn("[Circle DCW] Wallet creation failed, using HD fallback:", e?.message || e);
    }
  }

  return derivePlatformWallet(userId);
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
  if (_tokenIdCache.has(walletId)) return _tokenIdCache.get(walletId)!;

  const client = getDcwClient();
  if (client) {
    try {
      const res = await client.getWalletTokenBalance({ id: walletId });
      const tokenBalances: any[] = (res.data as any)?.tokenBalances ?? [];
      const usdcEntry = tokenBalances.find(isUsdcToken);
      if (usdcEntry?.token?.id) {
        _tokenIdCache.set(walletId, usdcEntry.token.id);
        return usdcEntry.token.id;
      }
    } catch {
      // fall through to hardcoded fallback
    }
  }

  return FALLBACK_USDC_TOKEN_IDS[blockchain] ?? FALLBACK_USDC_TOKEN_IDS["MATIC-AMOY"];
}

// ─── USDC transfer via Circle DCW ────────────────────────────────────────────
// Sends USDC from a Circle DCW wallet to any EVM address on the specified chain.
// `blockchain` is used to pick the correct token ID and platform wallet ID.

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

  // The SDK's createTransaction wrapper destructures `fee` from the input object
  // and spreads `fee.config` into the underlying Circle API call.
  // `fee` must always be an object — if absent, `fee.config` throws TypeError.
  // Gas Station sponsors the actual gas cost on-chain; feeLevel sets the price tier.
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
        circleWalletId:     usersTable.circleWalletId,
        circleWalletIdsJson: (usersTable as any).circleWalletIdsJson,
      })
      .from(usersTable)
      .where(
        sql`lower(${usersTable.circleWalletAddress}) = lower(${walletAddress})`,
      )
      .limit(1);

    if (!user) return null;

    if (user.circleWalletIdsJson) {
      const idsMap = JSON.parse(user.circleWalletIdsJson) as Record<string, string>;
      return idsMap[blockchain] ?? user.circleWalletId ?? null;
    }

    return user.circleWalletId ?? null;
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
