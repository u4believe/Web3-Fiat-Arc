import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import escrowRouter from "./escrow.js";
import withdrawRouter from "./withdraw.js";
import indexerRouter from "./indexer.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/escrow", escrowRouter);
router.use("/withdraw", withdrawRouter);
router.use("/indexer", indexerRouter);

export default router;
