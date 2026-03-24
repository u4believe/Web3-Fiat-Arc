import { Router, type IRouter } from "express";
import { db, chainTransactionsTable, escrowBalancesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getIndexerStatus } from "../lib/indexer.js";

const router: IRouter = Router();

// GET /api/indexer/status
router.get("/status", async (req, res) => {
  try {
    const status = getIndexerStatus();
    res.json(status);
  } catch (err: any) {
    req.log.error({ err }, "Indexer status error");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// GET /api/indexer/transactions?emailHash=0x...
router.get("/transactions", async (req, res) => {
  try {
    const { emailHash } = req.query;

    let txs;
    if (emailHash && typeof emailHash === "string") {
      txs = await db
        .select()
        .from(chainTransactionsTable)
        .where(eq(chainTransactionsTable.emailHash, emailHash))
        .orderBy(desc(chainTransactionsTable.createdAt))
        .limit(50);
    } else {
      txs = await db
        .select()
        .from(chainTransactionsTable)
        .orderBy(desc(chainTransactionsTable.createdAt))
        .limit(50);
    }

    res.json({ transactions: txs });
  } catch (err: any) {
    req.log.error({ err }, "Indexer transactions error");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// GET /api/indexer/balance/:emailHash
router.get("/balance/:emailHash", async (req, res) => {
  try {
    const { emailHash } = req.params;
    const [balance] = await db
      .select()
      .from(escrowBalancesTable)
      .where(eq(escrowBalancesTable.emailHash, emailHash))
      .limit(1);

    res.json({
      emailHash,
      amount: balance?.amount ?? "0.000000",
      lastUpdated: balance?.lastUpdated ?? null,
    });
  } catch (err: any) {
    req.log.error({ err }, "Indexer balance error");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

export default router;
