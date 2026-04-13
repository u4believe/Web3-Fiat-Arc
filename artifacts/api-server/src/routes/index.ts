import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import escrowRouter from "./escrow.js";
import withdrawRouter from "./withdraw.js";
import depositRouter from "./deposit.js";
import indexerRouter from "./indexer.js";

import recurringRouter from "./recurring.js";
import securityRouter from "./security.js";
import adminRouter from "./admin.js";
import userRouter from "./user.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/escrow", escrowRouter);
router.use("/withdraw", withdrawRouter);
router.use("/deposit", depositRouter);
router.use("/indexer", indexerRouter);
router.use("/recurring", recurringRouter);
router.use("/security", securityRouter);
router.use("/admin", adminRouter);
router.use("/user", userRouter);

export default router;
