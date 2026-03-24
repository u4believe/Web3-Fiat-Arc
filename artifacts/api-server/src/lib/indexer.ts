import { ethers } from "ethers";
import { db, escrowBalancesTable, chainTransactionsTable, indexerStateTable, escrowsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getProvider, getEscrowContract, formatUsdcAmount } from "./escrow.js";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 15_000;       // poll every 15 seconds
const BLOCKS_PER_CHUNK = 200;          // small chunks to avoid RPC rate limits
const CHUNK_DELAY_MS = 1_000;          // 1s pause between chunks
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 3;

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export interface IndexerStatus {
  running: boolean;
  lastProcessedBlock: string;
  currentBlock: string | null;
  lag: string | null;
}

let lastStatus: IndexerStatus = {
  running: false,
  lastProcessedBlock: "0",
  currentBlock: null,
  lag: null,
};

export function getIndexerStatus(): IndexerStatus {
  return lastStatus;
}

// ─── Upsert helpers ─────────────────────────────────────────────────────────

async function upsertEscrowBalance(emailHash: string, delta: string, mode: "add" | "subtract") {
  const [existing] = await db
    .select()
    .from(escrowBalancesTable)
    .where(eq(escrowBalancesTable.emailHash, emailHash))
    .limit(1);

  if (existing) {
    const current = parseFloat(existing.amount);
    const change = parseFloat(delta);
    const next = mode === "add" ? current + change : Math.max(0, current - change);
    await db
      .update(escrowBalancesTable)
      .set({ amount: next.toFixed(6), lastUpdated: new Date() })
      .where(eq(escrowBalancesTable.emailHash, emailHash));
  } else {
    const amount = mode === "add" ? parseFloat(delta).toFixed(6) : "0.000000";
    await db.insert(escrowBalancesTable).values({ emailHash, amount, lastUpdated: new Date() });
  }
}

async function insertChainTx(
  type: "deposit" | "claim",
  txHash: string,
  emailHash: string,
  amount: string,
  blockNumber: bigint,
  senderAddress?: string,
  recipientAddress?: string,
) {
  try {
    await db.insert(chainTransactionsTable).values({
      type,
      txHash,
      emailHash,
      amount,
      senderAddress: senderAddress ?? null,
      recipientAddress: recipientAddress ?? null,
      blockNumber,
      createdAt: new Date(),
    });
  } catch (err: any) {
    // Unique violation on tx_hash — already indexed, skip silently
    if (err?.code === "23505") return;
    throw err;
  }
}

// ─── Event processors ────────────────────────────────────────────────────────

async function handleDeposited(log: ethers.EventLog) {
  const sender: string = log.args[0];
  const emailHash: string = log.args[1];
  const amountWei: bigint = log.args[2];
  const amount = formatUsdcAmount(amountWei);
  const txHash = log.transactionHash;
  const blockNumber = BigInt(log.blockNumber);

  logger.info({ txHash, emailHash, amount, sender }, "[indexer] Deposited event");

  await insertChainTx("deposit", txHash, emailHash, amount, blockNumber, sender);
  await upsertEscrowBalance(emailHash, amount, "add");

  // Sync to our escrows table if we have a matching record
  await db
    .update(escrowsTable)
    .set({ txHash, status: "pending" })
    .where(and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending")));
}

async function handleClaimed(log: ethers.EventLog) {
  const emailHash: string = log.args[0];
  const recipient: string = log.args[1];
  const amountWei: bigint = log.args[2];
  const amount = formatUsdcAmount(amountWei);
  const txHash = log.transactionHash;
  const blockNumber = BigInt(log.blockNumber);

  logger.info({ txHash, emailHash, amount, recipient }, "[indexer] Claimed event");

  await insertChainTx("claim", txHash, emailHash, amount, blockNumber, undefined, recipient);
  await upsertEscrowBalance(emailHash, amount, "subtract");

  // Mark escrow as claimed
  await db
    .update(escrowsTable)
    .set({ status: "claimed", claimTxHash: txHash, claimedAt: new Date() })
    .where(and(eq(escrowsTable.emailHash, emailHash), eq(escrowsTable.status, "pending")));
}

// ─── Core polling logic ──────────────────────────────────────────────────────

async function processChunk(
  contract: ethers.Contract,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const depositFilter = contract.filters.Deposited();
  const claimFilter = contract.filters.Claimed();

  // Sequential queries to avoid hitting RPC rate limits
  const deposits = await contract.queryFilter(depositFilter, Number(fromBlock), Number(toBlock)) as ethers.EventLog[];
  await new Promise((r) => setTimeout(r, 500)); // brief pause between queries
  const claims = await contract.queryFilter(claimFilter, Number(fromBlock), Number(toBlock)) as ethers.EventLog[];

  // Process in block order
  const all = [...deposits, ...claims].sort((a, b) => {
    const blockDiff = a.blockNumber - b.blockNumber;
    if (blockDiff !== 0) return blockDiff;
    return a.transactionIndex - b.transactionIndex;
  });

  for (const log of all) {
    if (log.fragment?.name === "Deposited") {
      await handleDeposited(log as ethers.EventLog);
    } else if (log.fragment?.name === "Claimed") {
      await handleClaimed(log as ethers.EventLog);
    }
  }

  return all.length;
}

async function poll() {
  if (!running) return;

  let retries = 0;
  while (retries < MAX_RETRIES) {
    try {
      const provider = getProvider();
      const contract = getEscrowContract(provider);

      const currentBlock = await provider.getBlockNumber();

      // Load last processed block from DB
      const [state] = await db.select().from(indexerStateTable).where(eq(indexerStateTable.id, 1)).limit(1);
      let lastBlock = state ? Number(state.lastProcessedBlock) : 0;

      // On first run (lastBlock = 0), bootstrap to current block minus a small
      // lookback window so we catch very recent events without replaying all history
      const LOOKBACK_BLOCKS = 500;
      if (lastBlock === 0) {
        lastBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
        await db
          .update(indexerStateTable)
          .set({ lastProcessedBlock: BigInt(lastBlock), updatedAt: new Date() })
          .where(eq(indexerStateTable.id, 1));
        logger.info({ startBlock: lastBlock, currentBlock }, "[indexer] First run — bootstrapping from recent block");
      }

      lastStatus.currentBlock = currentBlock.toString();
      lastStatus.lastProcessedBlock = lastBlock.toString();
      lastStatus.lag = (currentBlock - lastBlock).toString();

      if (lastBlock >= currentBlock) {
        // Nothing new to process
        break;
      }

      // Process in chunks to avoid RPC timeouts / rate limits
      let from = lastBlock + 1;
      let totalProcessed = 0;

      while (from <= currentBlock) {
        const to = Math.min(from + BLOCKS_PER_CHUNK - 1, currentBlock);
        const count = await processChunk(contract, BigInt(from), BigInt(to));
        totalProcessed += count;

        // Update state after each chunk
        await db
          .update(indexerStateTable)
          .set({ lastProcessedBlock: BigInt(to), updatedAt: new Date() })
          .where(eq(indexerStateTable.id, 1));

        from = to + 1;

        // Rate-limit pause between chunks
        if (from <= currentBlock) {
          await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
        }
      }

      if (totalProcessed > 0) {
        logger.info({ totalProcessed, upToBlock: currentBlock }, "[indexer] Processed events");
      }

      lastStatus.lastProcessedBlock = currentBlock.toString();
      lastStatus.lag = "0";
      break; // success
    } catch (err: any) {
      retries++;
      logger.warn({ err: err.message, retries }, "[indexer] Poll error, retrying...");
      if (retries >= MAX_RETRIES) {
        logger.error({ err: err.message }, "[indexer] Max retries reached, skipping poll");
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  if (running) {
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }
}

// ─── Public start / stop ─────────────────────────────────────────────────────

export async function startIndexer() {
  if (running) return;
  running = true;
  lastStatus.running = true;
  logger.info("[indexer] Starting blockchain event indexer");
  poll(); // kick off immediately, then schedule
}

export async function stopIndexer() {
  running = false;
  lastStatus.running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info("[indexer] Indexer stopped");
}
