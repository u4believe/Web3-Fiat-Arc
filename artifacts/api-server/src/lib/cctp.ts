/**
 * Circle Cross-Chain Transfer Protocol (CCTP) v1 bridge.
 *
 * Moves USDC from any supported treasury chain (ETH-SEPOLIA, MATIC-AMOY) to the
 * primary treasury chain (BASE-SEPOLIA) using Circle's own burn-and-mint protocol.
 *
 * Flow:
 *   1. [Source] Approve TokenMessenger to spend USDC from the platform treasury wallet
 *   2. [Source] depositForBurn → emits MessageSent event
 *   3.          Wait for Circle DCW to confirm the burn tx and extract on-chain txHash
 *   4.          Fetch on-chain receipt → parse MessageSent bytes from MessageTransmitter
 *   5.          Poll Circle attestation API until attestation is ready (~20 s)
 *   6. [Dest]   receiveMessage on the destination chain's MessageTransmitter
 *
 * CCTP v1 testnet contracts (same address on all supported chains):
 *   TokenMessenger:     0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
 *   MessageTransmitter: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
 *
 * Domain IDs:
 *   ETH-Sepolia   = 0
 *   Base-Sepolia  = 6
 *   Polygon-Amoy  = 7
 */

import { ethers } from "ethers";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getPlatformWalletAddress, getPlatformWalletIdForChain, type SupportedBlockchain } from "./circle.js";
import { logger } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_MESSENGER      = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER  = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const ATTESTATION_API_BASE = "https://iris-api-sandbox.circle.com";

const DOMAIN_IDS: Record<string, number> = {
  "ETH-SEPOLIA":  0,
  "BASE-SEPOLIA": 6,
  "MATIC-AMOY":   7,
};

const CHAIN_RPC_URLS: Record<string, string> = {
  "ETH-SEPOLIA":  process.env.ETH_SEPOLIA_RPC_URL  ?? "https://ethereum-sepolia-rpc.publicnode.com",
  "BASE-SEPOLIA": process.env.BASE_SEPOLIA_RPC_URL  ?? "https://sepolia.base.org",
  "MATIC-AMOY":   process.env.POLYGON_AMOY_RPC_URL  ?? "https://rpc-amoy.polygon.technology/",
};

const USDC_ADDRESSES: Record<string, string> = {
  "ETH-SEPOLIA":  (process.env.ETH_SEPOLIA_USDC_ADDRESS ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").toLowerCase(),
  "BASE-SEPOLIA": (process.env.BASE_USDC_ADDRESS         ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e").toLowerCase(),
  "MATIC-AMOY":   (process.env.POLYGON_AMOY_USDC_ADDRESS ?? "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582").toLowerCase(),
};

// MessageSent(bytes) event topic
const MESSAGE_SENT_TOPIC = ethers.id("MessageSent(bytes)");

// ─── DCW client ───────────────────────────────────────────────────────────────

function getCctpDcwClient() {
  const apiKey       = process.env.CIRCLE_API_KEY!;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET not set — cannot execute CCTP bridge");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Poll the Circle DCW API until the transaction reaches a terminal state.
 * Returns the on-chain txHash when CONFIRMED.
 */
async function waitForCircleTx(
  client: ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  txId: string,
  maxWaitMs = 180_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await client.getTransaction({ id: txId });
    const tx: any =
      (res.data as any)?.transaction ??
      (res.data as any)?.data?.transaction ??
      (res as any)?.transaction;
    const state:       string = tx?.state       ?? "";
    const txHash:      string = tx?.txHash      ?? "";
    const errorReason: string = tx?.errorReason ?? tx?.errorMessage ?? tx?.error ?? "";

    if (state === "CONFIRMED" || state === "COMPLETE") {
      if (!txHash) throw new Error(`Circle tx ${txId} confirmed but has no txHash`);
      return txHash;
    }
    if (["FAILED", "DENIED", "CANCELLED"].includes(state)) {
      // Log the full tx object so we can diagnose the exact Circle error
      logger.error(
        { txId, state, errorReason, fullTx: JSON.stringify(tx).slice(0, 500) },
        "[cctp] Circle transaction failed — full details above",
      );
      throw new Error(
        `Circle tx ${txId} ended with state: ${state}${errorReason ? ` — ${errorReason}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Circle tx ${txId} timed out after ${maxWaitMs} ms`);
}

/**
 * Pull the transaction ID out of any Circle DCW response shape.
 */
function extractTxId(res: any): string {
  const body = res.data as any;
  const id: string | undefined =
    body?.data?.id          ??
    body?.transaction?.id   ??
    body?.id                ??
    (res as any)?.transaction?.id;
  if (!id) throw new Error("Circle DCW returned no transaction ID");
  return id;
}

/**
 * Get the `MessageSent` event bytes from an on-chain tx receipt.
 * The event is emitted by the MessageTransmitter during a depositForBurn call.
 */
async function getMessageBytesFromTx(rpcUrl: string, txHash: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Retry a few times — RPC may not have indexed the receipt immediately
  for (let attempt = 0; attempt < 6; attempt++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      for (const log of receipt.logs) {
        if (log.topics[0] === MESSAGE_SENT_TOPIC) {
          const [messageBytes] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], log.data);
          return messageBytes as string;
        }
      }
      throw new Error(`MessageSent event not found in tx ${txHash}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Transaction receipt not found for ${txHash} after retries`);
}

/**
 * Poll Circle's attestation API until the attestation is ready.
 * Typically takes 10–30 seconds on testnet.
 */
async function fetchAttestation(messageBytes: string, maxWaitMs = 300_000): Promise<string> {
  const messageHash = ethers.keccak256(messageBytes);
  const url = `${ATTESTATION_API_BASE}/attestations/${messageHash}`;
  logger.info({ messageHash }, "[cctp] Polling for attestation");

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.get(url, { validateStatus: () => true });
      if (res.status === 200 && res.data?.status === "complete") {
        logger.info({ messageHash }, "[cctp] Attestation ready");
        return res.data.attestation as string;
      }
    } catch (e: any) {
      // Transient network errors — keep polling
      logger.warn({ err: e?.message }, "[cctp] Attestation poll error — retrying");
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Attestation timed out after ${maxWaitMs} ms for message ${messageHash}`);
}

// ─── Main bridge function ─────────────────────────────────────────────────────

export interface CctpBridgeResult {
  burnTxHash: string;
  mintTxId:   string;
  sourceChain: string;
  destChain:   string;
  amount:      string;
}

/**
 * Bridge USDC from sourceChain platform treasury to destChain platform treasury
 * using Circle CCTP v1.
 *
 * All Circle DCW transactions are signed by the platform treasury wallet on the
 * respective chain (identified by CIRCLE_PLATFORM_WALLET_ID_<CHAIN> env vars).
 */
export async function cctpBridgeToTreasury(
  sourceChain: SupportedBlockchain,
  destChain:   SupportedBlockchain,
  amount:      string,
): Promise<CctpBridgeResult> {
  if (sourceChain === destChain) {
    throw new Error("sourceChain and destChain must be different");
  }

  const client = getCctpDcwClient();

  const sourceWalletId  = getPlatformWalletIdForChain(sourceChain);
  const destWalletId    = getPlatformWalletIdForChain(destChain);
  const platformAddress = getPlatformWalletAddress();

  if (!sourceWalletId)  throw new Error(`CIRCLE_PLATFORM_WALLET_ID not set for ${sourceChain}`);
  if (!destWalletId)    throw new Error(`CIRCLE_PLATFORM_WALLET_ID not set for ${destChain}`);
  if (!platformAddress) throw new Error("CIRCLE_PLATFORM_WALLET_ADDRESS not set");

  const destDomain  = DOMAIN_IDS[destChain];
  const usdcAddress = USDC_ADDRESSES[sourceChain];
  const rpcUrl      = CHAIN_RPC_URLS[sourceChain];

  if (destDomain === undefined) throw new Error(`Unknown CCTP domain for ${destChain}`);

  const amountUnits = ethers.parseUnits(amount, 6); // USDC has 6 decimals
  // mintRecipient must be bytes32 — left-pad the platform address with zeros
  const mintRecipient = ethers.zeroPadValue(platformAddress.toLowerCase(), 32);

  logger.info(
    { sourceChain, destChain, amount, sourceWalletId, destWalletId, platformAddress },
    "[cctp] Starting CCTP bridge",
  );

  // Pre-encode all calldata with ethers — Circle's abiParameters only supports
  // string/number/boolean and cannot handle bytes32 or bytes types correctly.
  // Using callData bypasses the SDK's ABI encoder entirely.
  const erc20Iface       = new ethers.Interface(["function approve(address,uint256)"]);
  const messengerIface   = new ethers.Interface(["function depositForBurn(uint256,uint32,bytes32,address)"]);
  const transmitterIface = new ethers.Interface(["function receiveMessage(bytes,bytes)"]);

  // The correct fee shape for createContractExecutionTransaction (different from createTransaction).
  // `as const` is required so TypeScript infers the literal types "level" and "MEDIUM"
  // instead of widening them to `string`, which would fail the SDK's FeeConfiguration type.
  const FEE = { type: "level", config: { feeLevel: "MEDIUM" } } as const;

  // ── Step 1: Approve TokenMessenger to spend USDC ──────────────────────────
  logger.info({ sourceChain, amount }, "[cctp] Step 1/5: Approving USDC for TokenMessenger");
  const approveCallData = erc20Iface.encodeFunctionData("approve", [TOKEN_MESSENGER, amountUnits]) as `0x${string}`;
  const approveRes = await client.createContractExecutionTransaction({
    walletId:        sourceWalletId,
    contractAddress: usdcAddress,
    callData:        approveCallData,
    fee:             FEE,
    idempotencyKey:  randomUUID(),
  });
  const approveTxId = extractTxId(approveRes);
  logger.info({ approveTxId }, "[cctp] Waiting for approval tx");
  await waitForCircleTx(client, approveTxId);

  // ── Step 2: depositForBurn ─────────────────────────────────────────────────
  logger.info({ sourceChain, destChain, amount }, "[cctp] Step 2/5: Calling depositForBurn");
  const burnCallData = messengerIface.encodeFunctionData("depositForBurn", [
    amountUnits,
    destDomain,
    mintRecipient,
    usdcAddress,
  ]) as `0x${string}`;
  const burnRes = await client.createContractExecutionTransaction({
    walletId:        sourceWalletId,
    contractAddress: TOKEN_MESSENGER,
    callData:        burnCallData,
    fee:             FEE,
    idempotencyKey:  randomUUID(),
  });
  const burnTxId   = extractTxId(burnRes);
  logger.info({ burnTxId }, "[cctp] Waiting for depositForBurn tx to confirm");
  const burnTxHash = await waitForCircleTx(client, burnTxId);
  logger.info({ burnTxHash }, "[cctp] depositForBurn confirmed on-chain");

  // ── Step 3: Parse MessageSent bytes from on-chain receipt ──────────────────
  logger.info({ burnTxHash }, "[cctp] Step 3/5: Extracting MessageSent bytes");
  const messageBytes = await getMessageBytesFromTx(rpcUrl, burnTxHash);

  // ── Step 4: Fetch attestation ──────────────────────────────────────────────
  logger.info("[cctp] Step 4/5: Fetching Circle attestation");
  const attestation = await fetchAttestation(messageBytes);

  // ── Step 5: receiveMessage on destination chain ────────────────────────────
  logger.info({ destChain, destWalletId }, "[cctp] Step 5/5: Calling receiveMessage on destination chain");
  const receiveCallData = transmitterIface.encodeFunctionData("receiveMessage", [messageBytes, attestation]) as `0x${string}`;
  const receiveRes = await client.createContractExecutionTransaction({
    walletId:        destWalletId,
    contractAddress: MESSAGE_TRANSMITTER,
    callData:        receiveCallData,
    fee:             FEE,
    idempotencyKey:  randomUUID(),
  });
  const mintTxId = extractTxId(receiveRes);

  logger.info(
    { sourceChain, destChain, amount, burnTxHash, mintTxId },
    "[cctp] Bridge initiated — USDC minting on destination chain",
  );

  return { burnTxHash, mintTxId, sourceChain, destChain, amount };
}

// ─── Treasury balance query ───────────────────────────────────────────────────

/**
 * Returns the USDC balance of the platform treasury wallet on each chain.
 * Reads directly from the ERC-20 contract via on-chain RPC.
 */
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

/**
 * Read the on-chain USDC balance of the platform treasury address on a given chain.
 * Uses a direct JSON-RPC call — no Circle API involved.
 */
async function getOnChainTreasuryBalance(chain: string): Promise<number> {
  const platformAddress = getPlatformWalletAddress();
  if (!platformAddress) return 0;

  const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URLS[chain]);
  const contract  = new ethers.Contract(USDC_ADDRESSES[chain], ERC20_BALANCE_ABI, provider);
  const raw: bigint = await contract.balanceOf(platformAddress);
  return parseFloat(ethers.formatUnits(raw, 6));
}

/**
 * Returns the USDC balance of the platform treasury wallet on each chain.
 * Reads directly from the ERC-20 contract via on-chain RPC.
 */
export async function getTreasuryBalancesAllChains(): Promise<
  Record<string, { balance: string; chain: string }>
> {
  const platformAddress = getPlatformWalletAddress();
  if (!platformAddress) return {};

  const results: Record<string, { balance: string; chain: string }> = {};
  await Promise.allSettled(
    (Object.keys(USDC_ADDRESSES) as SupportedBlockchain[]).map(async (chain) => {
      try {
        const balance = await getOnChainTreasuryBalance(chain);
        results[chain] = { balance: balance.toFixed(6), chain };
      } catch {
        results[chain] = { balance: "error", chain };
      }
    }),
  );

  return results;
}

// ─── Periodic CCTP consolidator ───────────────────────────────────────────────

/**
 * Chains that should be drained into the primary treasury (BASE-SEPOLIA).
 * BASE-SEPOLIA is excluded — it IS the destination.
 */
const CONSOLIDATION_SOURCES: SupportedBlockchain[] = ["ETH-SEPOLIA", "MATIC-AMOY"];

/**
 * Minimum USDC balance that triggers a bridge.
 * Prevents wasting gas on dust amounts.
 */
const MIN_BRIDGE_AMOUNT = parseFloat(process.env.CCTP_MIN_BRIDGE_AMOUNT ?? "1.0");

/** Poll interval in ms — defaults to 60 s */
const CONSOLIDATOR_INTERVAL_MS = parseInt(process.env.CCTP_CONSOLIDATOR_INTERVAL_MS ?? "60000", 10);

// Per-chain lock — prevents starting a second bridge while one is in progress.
// A bridge takes ~1–3 min; the poll runs every 60 s, so without this flag a new
// bridge attempt would fire every minute on top of the running one.
const _bridgeInProgress = new Map<string, boolean>();

let _consolidatorTimer: ReturnType<typeof setTimeout> | null = null;
let _consolidatorRunning = false;

async function runConsolidation() {
  const primaryChain = "BASE-SEPOLIA" as SupportedBlockchain;

  for (const sourceChain of CONSOLIDATION_SOURCES) {
    if (_bridgeInProgress.get(sourceChain)) {
      logger.info({ sourceChain }, "[cctp/consolidator] Bridge already in progress — skipping tick");
      continue;
    }

    try {
      const balance = await getOnChainTreasuryBalance(sourceChain);
      logger.info({ sourceChain, balance }, "[cctp/consolidator] Treasury balance check");

      if (balance < MIN_BRIDGE_AMOUNT) {
        logger.info(
          { sourceChain, balance, threshold: MIN_BRIDGE_AMOUNT },
          "[cctp/consolidator] Below threshold — nothing to bridge",
        );
        continue;
      }

      // Verify destination wallet is configured before locking
      const destWalletId = getPlatformWalletIdForChain(primaryChain);
      const srcWalletId  = getPlatformWalletIdForChain(sourceChain);
      if (!destWalletId || !srcWalletId) {
        logger.warn(
          { sourceChain, primaryChain },
          "[cctp/consolidator] Platform wallet IDs not configured — skipping",
        );
        continue;
      }

      // Lock this chain and fire bridge in background
      _bridgeInProgress.set(sourceChain, true);
      const amount = balance.toFixed(6);

      logger.info(
        { sourceChain, destChain: primaryChain, amount },
        "[cctp/consolidator] Starting CCTP bridge",
      );

      cctpBridgeToTreasury(sourceChain, primaryChain, amount)
        .then((result) => {
          logger.info(result, "[cctp/consolidator] Bridge completed successfully");
        })
        .catch((err: any) => {
          logger.error(
            { sourceChain, amount, err: err?.message },
            "[cctp/consolidator] Bridge failed",
          );
        })
        .finally(() => {
          _bridgeInProgress.set(sourceChain, false);
        });

    } catch (err: any) {
      logger.warn({ sourceChain, err: err?.message }, "[cctp/consolidator] Balance check failed");
    }
  }
}

function scheduleNext() {
  if (!_consolidatorRunning) return;
  _consolidatorTimer = setTimeout(async () => {
    await runConsolidation().catch((err: any) =>
      logger.error({ err: err?.message }, "[cctp/consolidator] Unexpected error in consolidation tick"),
    );
    scheduleNext();
  }, CONSOLIDATOR_INTERVAL_MS);
}

/**
 * Start the background CCTP consolidator.
 * Every CCTP_CONSOLIDATOR_INTERVAL_MS (default 60 s) it checks the on-chain USDC
 * balance of the ETH-SEPOLIA and MATIC-AMOY platform treasury wallets. If either
 * exceeds CCTP_MIN_BRIDGE_AMOUNT (default $1), it bridges that amount to BASE-SEPOLIA.
 *
 * Required env vars:
 *   CIRCLE_PLATFORM_WALLET_ADDRESS               — shared on-chain address
 *   CIRCLE_PLATFORM_WALLET_ID_BASE_SEPOLIA        — dest Circle wallet ID
 *   CIRCLE_PLATFORM_WALLET_ID_ETH_SEPOLIA         — source Circle wallet ID
 *   CIRCLE_PLATFORM_WALLET_ID_MATIC_AMOY          — source Circle wallet ID
 *   CIRCLE_GAS_STATION_ENABLED=true               — gas sponsorship
 *
 * Optional:
 *   CCTP_MIN_BRIDGE_AMOUNT=1.0                    — minimum USDC to trigger a bridge
 *   CCTP_CONSOLIDATOR_INTERVAL_MS=60000           — poll interval in ms
 */
export function startCctpConsolidator() {
  if (_consolidatorRunning) return;

  const platformAddress = getPlatformWalletAddress();
  if (!platformAddress) {
    logger.warn("[cctp/consolidator] CIRCLE_PLATFORM_WALLET_ADDRESS not set — consolidator disabled");
    return;
  }

  _consolidatorRunning = true;
  logger.info(
    { intervalMs: CONSOLIDATOR_INTERVAL_MS, minBridgeAmount: MIN_BRIDGE_AMOUNT },
    "[cctp/consolidator] Started",
  );

  // Run first tick after one interval (give the server time to fully start up)
  scheduleNext();
}

export function stopCctpConsolidator() {
  _consolidatorRunning = false;
  if (_consolidatorTimer) {
    clearTimeout(_consolidatorTimer);
    _consolidatorTimer = null;
  }
  logger.info("[cctp/consolidator] Stopped");
}
