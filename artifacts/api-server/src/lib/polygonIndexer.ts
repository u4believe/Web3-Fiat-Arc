/**
 * Multi-network USDC deposit indexer.
 *
 * Polls ERC-20 Transfer events on every configured network where `to` matches
 * a known user circleWalletAddress. Credits claimedBalance and records a deposit
 * row (idempotent via txHash) when a match is found.
 *
 * Each network gets its own row in indexer_state (id >= 2; id=1 is ARC escrow).
 */

import { ethers } from "ethers";
import { db, usersTable, depositsTable, indexerStateTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { circleTransferUsdc, getPlatformWalletAddress, PRIMARY_USDC_ADDRESS, type SupportedBlockchain } from "./circle.js";

// ─── Network registry ────────────────────────────────────────────────────────

interface NetworkConfig {
  name: string;
  rpcUrl: string;
  usdcAddress: string;
  indexerStateId: number;   // unique row id in indexer_state; must be >= 2
  circleBlockchain: string; // Circle blockchain identifier for DCW API
}

// Platform supports Base Sepolia only — single network, single treasury.
const NETWORKS: NetworkConfig[] = [
  {
    name: "Base Sepolia",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    usdcAddress: (process.env.BASE_USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e").toLowerCase(),
    indexerStateId: 3,
    circleBlockchain: "BASE-SEPOLIA",
  },
];

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;    // 5 s — worst-case latency after tx confirms
const BLOCKS_PER_CHUNK = 50;       // public RPCs cap eth_getLogs range
const CHUNK_DELAY_MS   = 200;      // reduced from 500 ms
const LOOKBACK_BLOCKS  = 200;      // ~4 min lookback on first run
// Refresh the in-memory address map every N polls to pick up new registrations
// without hitting the DB on every single cycle.
const ADDRESS_REFRESH_INTERVAL = 12;   // 12 × 5 s = 60 s

const ERC20_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

// ─── Per-network runner ───────────────────────────────────────────────────────

class NetworkIndexer {
  private running   = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Persistent across polls — avoids reconnecting every cycle
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private decimals: number | null = null;

  // Address map cache — refreshed every ADDRESS_REFRESH_INTERVAL polls
  private addressMap: Map<string, number> = new Map();
  private pollCount = 0;

  constructor(private readonly cfg: NetworkConfig) {}

  start() {
    if (this.running) return;
    this.running = true;
    logger.info(`[usdc-indexer:${this.cfg.name}] Starting`);
    this.initProvider();
    this.poll();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.provider = null;
    this.contract = null;
    logger.info(`[usdc-indexer:${this.cfg.name}] Stopped`);
  }

  private initProvider() {
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
    this.contract = new ethers.Contract(this.cfg.usdcAddress, ERC20_TRANSFER_ABI, this.provider);
  }

  private async getDecimals(): Promise<number> {
    if (this.decimals !== null) return this.decimals;
    this.decimals = Number(await this.contract!.decimals());
    return this.decimals;
  }

  private async getOrInitLastBlock(currentBlock: number): Promise<number> {
    const [state] = await db
      .select()
      .from(indexerStateTable)
      .where(eq(indexerStateTable.id, this.cfg.indexerStateId))
      .limit(1);

    if (state) return Number(state.lastProcessedBlock);

    const startBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
    await db.insert(indexerStateTable).values({
      id: this.cfg.indexerStateId,
      lastProcessedBlock: BigInt(startBlock),
    });
    logger.info(
      { startBlock, currentBlock, network: this.cfg.name },
      `[usdc-indexer:${this.cfg.name}] First run — bootstrapping`,
    );
    return startBlock;
  }

  private async saveLastBlock(block: number) {
    await db
      .update(indexerStateTable)
      .set({ lastProcessedBlock: BigInt(block), updatedAt: new Date() })
      .where(eq(indexerStateTable.id, this.cfg.indexerStateId));
  }

  private async refreshAddressMap() {
    const rows = await db
      .select({ id: usersTable.id, addr: usersTable.circleWalletAddress })
      .from(usersTable)
      .where(sql`${usersTable.circleWalletAddress} is not null`);

    this.addressMap = new Map();
    for (const { id, addr } of rows) {
      if (addr) this.addressMap.set(addr.toLowerCase(), id);
    }
  }

  private async creditDeposit(userId: number, amount: string, txHash: string, userAddress: string) {
    // Idempotency
    const [dup] = await db
      .select({ id: depositsTable.id })
      .from(depositsTable)
      .where(eq(depositsTable.txHash, txHash))
      .limit(1);
    if (dup) return;

    const [dbUser] = await db
      .select({ claimedBalance: usersTable.claimedBalance })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const newBalance = (
      parseFloat(dbUser?.claimedBalance ?? "0") + parseFloat(amount)
    ).toFixed(6);

    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, userId));
    await db.insert(depositsTable).values({
      userId,
      amount,
      type: "crypto",
      source: `${this.cfg.name} USDC`,
      status: "completed",
      depositReference: txHash,
      txHash,
      creditedAt: new Date(),
    });

    logger.info(
      { txHash, userId, amount, network: this.cfg.name },
      `[usdc-indexer:${this.cfg.name}] Credited USDC deposit`,
    );

    // Sweep deposited USDC from the user's SCA wallet to the platform treasury.
    // Gas Station sponsors gas for SCA wallets — no native ETH needed in user wallets.
    const platformAddress = getPlatformWalletAddress();
    if (platformAddress && userAddress.toLowerCase() !== platformAddress.toLowerCase()) {
      circleTransferUsdc(userAddress, platformAddress, "BASE-SEPOLIA" as SupportedBlockchain, PRIMARY_USDC_ADDRESS, amount)
        .then(() => logger.info({ userId, amount }, `[usdc-indexer] Swept deposit to treasury`))
        .catch((e: any) => logger.warn({ err: e?.message, userId, amount }, `[usdc-indexer] Sweep failed`));
    }
  }

  private async processChunk(
    fromBlock: number,
    toBlock: number,
  ) {
    const filter = this.contract!.filters.Transfer();
    const logs = await this.contract!.queryFilter(filter, fromBlock, toBlock) as ethers.EventLog[];

    for (const log of logs) {
      const to     = (log.args[1] as string).toLowerCase();
      const userId = this.addressMap.get(to);
      if (!userId) continue;

      const decimals = await this.getDecimals();
      const value    = log.args[2] as bigint;
      const amount   = parseFloat(ethers.formatUnits(value, decimals)).toFixed(6);
      await this.creditDeposit(userId, amount, log.transactionHash, to);
    }
  }

  private async poll() {
    if (!this.running) return;

    try {
      // Reconnect if provider was dropped
      if (!this.provider || !this.contract) this.initProvider();

      // Refresh address map periodically, and always on first poll
      if (this.pollCount % ADDRESS_REFRESH_INTERVAL === 0) {
        await this.refreshAddressMap();
      }
      this.pollCount++;

      if (this.addressMap.size > 0) {
        const currentBlock = await this.provider!.getBlockNumber();
        let lastBlock = await this.getOrInitLastBlock(currentBlock);

        let from = lastBlock + 1;
        while (from <= currentBlock) {
          const to = Math.min(from + BLOCKS_PER_CHUNK - 1, currentBlock);
          await this.processChunk(from, to);
          await this.saveLastBlock(to);
          from = to + 1;
          if (from <= currentBlock) {
            await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
          }
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, network: this.cfg.name }, `[usdc-indexer:${this.cfg.name}] Poll error`);
      // Reset provider on error so it reconnects next cycle
      this.provider = null;
      this.contract = null;
    }

    if (this.running) {
      this.timer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
    }
  }
}

// ─── Module-level instances ───────────────────────────────────────────────────

const indexers = NETWORKS.map((cfg) => new NetworkIndexer(cfg));

export function startPolygonIndexer() {
  indexers.forEach((idx) => idx.start());
}

export function stopPolygonIndexer() {
  indexers.forEach((idx) => idx.stop());
}
