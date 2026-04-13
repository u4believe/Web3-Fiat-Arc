/**
 * USDC Sweep Worker
 *
 * Runs every 60 seconds. Sweeps USDC from user wallet addresses into the platform
 * treasury so it stays funded for withdrawals.
 *
 * Two paths:
 *   1. Circle DCW wallets  — users with real Circle wallet UUIDs (non platform-* IDs).
 *      Uses the Circle DCW API to transfer.
 *   2. HD fallback wallets — users whose walletId is `platform-{userId}`.
 *      The private key is derived from BACKEND_SIGNER_PRIVATE_KEY via the same
 *      HD path used at registration, and USDC is swept on-chain with ethers.js.
 *
 * Required env vars:
 *   CIRCLE_PLATFORM_WALLET_ADDRESS  — on-chain address of the platform treasury
 *   BACKEND_SIGNER_PRIVATE_KEY      — HD master key (used for HD fallback wallets)
 *   BASE_SEPOLIA_RPC_URL            — (optional) RPC for Base Sepolia; defaults to public endpoint
 */

import { ethers } from "ethers";
import { db, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  getPlatformWalletAddress,
  PRIMARY_BLOCKCHAIN,
} from "./circle.js";
import { logger } from "./logger.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 60_000;   // 60 s
const DUST_THRESHOLD    = 0.10;      // skip wallets with < $0.10 USDC (saves gas)
const GAS_RESERVE       = 0.001;     // keep this much ETH on user wallet as gas buffer

// Per-chain USDC contract addresses (for on-chain sweeps of HD wallets)
const CHAIN_USDC_ADDRESS: Record<string, string> = {
  "MATIC-AMOY":   process.env.POLYGON_AMOY_USDC_ADDRESS  ?? "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
  "ETH-SEPOLIA":  process.env.ETH_SEPOLIA_USDC_ADDRESS   ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "BASE-SEPOLIA": process.env.BASE_USDC_ADDRESS          ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// Per-chain public RPC URLs for HD wallet sweeps
const CHAIN_RPC_URL: Record<string, string> = {
  "MATIC-AMOY":   process.env.POLYGON_AMOY_RPC_URL  ?? "https://rpc-amoy.polygon.technology/",
  "ETH-SEPOLIA":  process.env.ETH_SEPOLIA_RPC_URL   ?? "https://ethereum-sepolia-rpc.publicnode.com",
  "BASE-SEPOLIA": process.env.BASE_SEPOLIA_RPC_URL  ?? "https://sepolia.base.org",
};

const MINIMAL_ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// ─── HD wallet helpers ────────────────────────────────────────────────────────

function deriveUserWallet(userId: number): ethers.HDNodeWallet {
  const rawKey = (process.env.BACKEND_SIGNER_PRIVATE_KEY ?? "").replace("0x", "").padStart(64, "0");
  const seed   = Buffer.from(rawKey, "hex");
  return ethers.HDNodeWallet.fromSeed(seed).derivePath(`m/44'/60'/0'/0/${userId}`);
}

// ─── Sweep: HD fallback wallets ───────────────────────────────────────────────
// For users whose circleWalletId is `platform-{userId}`, the platform derived
// the private key locally. We sign and broadcast a USDC transfer directly.

async function sweepHdUser(
  userId: number,
  walletAddress: string,
  blockchain: string,
  platformAddress: string,
): Promise<void> {
  const rpcUrl      = CHAIN_RPC_URL[blockchain];
  const usdcAddress = CHAIN_USDC_ADDRESS[blockchain];
  if (!rpcUrl || !usdcAddress) return;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const hdWallet  = deriveUserWallet(userId).connect(provider);

  // Sanity-check: derived address must match what's stored
  if (hdWallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
    logger.warn({ userId, stored: walletAddress, derived: hdWallet.address }, "[sweep:hd] Address mismatch — skipping");
    return;
  }

  const usdc     = new ethers.Contract(usdcAddress, MINIMAL_ERC20_ABI, hdWallet);
  const decimals = await usdc.decimals() as bigint;
  const raw      = await usdc.balanceOf(walletAddress) as bigint;
  const amount   = Number(raw) / 10 ** Number(decimals);

  if (amount < DUST_THRESHOLD) return;

  // Check ETH balance — skip if not enough for gas
  const ethBalance = await provider.getBalance(walletAddress);
  if (ethBalance === 0n) {
    logger.debug({ userId, blockchain, amount }, "[sweep:hd] No ETH for gas — skipping");
    return;
  }

  try {
    const tx = await usdc.transfer(platformAddress, raw);
    const receipt = await tx.wait(1);
    logger.info(
      { userId, blockchain, amount, txHash: receipt?.hash ?? tx.hash },
      "[sweep:hd] Swept USDC to treasury (on-chain)",
    );
  } catch (e: any) {
    logger.warn({ userId, blockchain, amount, err: e?.message }, "[sweep:hd] Transfer failed");
  }
}

// ─── Main sweep cycle ─────────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  const platformAddress = getPlatformWalletAddress();
  if (!platformAddress) {
    logger.debug("[sweep] CIRCLE_PLATFORM_WALLET_ADDRESS not set — skipping");
    return;
  }

  const allUsers = await db
    .select({
      id:                  usersTable.id,
      circleWalletId:      usersTable.circleWalletId,
      circleWalletAddress: usersTable.circleWalletAddress,
      circleWalletIdsJson: (usersTable as any).circleWalletIdsJson,
    })
    .from(usersTable)
    .where(sql`${usersTable.circleWalletAddress} is not null`);

  if (allUsers.length === 0) return;

  // Circle DCW users withdraw directly from their own wallet — no sweep needed.
  // Only HD fallback users (platform-*) need their on-chain USDC moved to the
  // treasury, because HD wallets can't be spent via the Circle DCW API.
  const hdUsers = allUsers.filter(u => u.circleWalletId?.startsWith("platform-"));

  if (hdUsers.length === 0) return;

  logger.info({ total: allUsers.length, hd: hdUsers.length }, "[sweep] Starting sweep cycle");

  // HD wallets — sweep PRIMARY_BLOCKCHAIN only (where deposits are tracked)
  for (const user of hdUsers) {
    if (!user.circleWalletAddress) continue;
    try {
      await sweepHdUser(user.id, user.circleWalletAddress, PRIMARY_BLOCKCHAIN, platformAddress);
    } catch (e: any) {
      logger.warn({ userId: user.id, err: e?.message }, "[sweep:hd] Unhandled error");
    }
  }
}

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

let sweepRunning = false;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

export function startSweepWorker(): void {
  if (sweepRunning) return;
  sweepRunning = true;
  logger.info("[sweep] Sweep worker started");

  const loop = async () => {
    if (!sweepRunning) return;
    try {
      await runSweep();
    } catch (e: any) {
      logger.warn({ err: e?.message }, "[sweep] Unhandled error in sweep cycle");
    }
    if (sweepRunning) {
      sweepTimer = setTimeout(loop, SWEEP_INTERVAL_MS);
    }
  };

  loop();
}

export function stopSweepWorker(): void {
  sweepRunning = false;
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  logger.info("[sweep] Sweep worker stopped");
}
