import { Router, type IRouter } from "express";
import { db, usersTable, withdrawalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { requireAuth } from "../lib/auth.js";
import {
  circleTransferUsdc,
  getWalletUsdcBalance,
  getPlatformWalletAddress,
  initiateWireTransfer,
  PRIMARY_BLOCKCHAIN,
  PRIMARY_USDC_ADDRESS,
} from "../lib/circle.js";
import { WithdrawCryptoBody, WithdrawFiatBodySecure } from "@workspace/api-zod";

const router: IRouter = Router();

// ─── Helper: load user balance ───────────────────────────────────────────────
async function loadUserBalance(userId: number) {
  const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return {
    dbUser,
    claimedBalance: parseFloat(dbUser?.claimedBalance ?? "0"),
  };
}

// ─── POST /api/withdraw/crypto ────────────────────────────────────────────────
router.post("/crypto", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const parsed = WithdrawCryptoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { walletAddress, amount } = parsed.data;
    const withdrawAmount = parseFloat(amount);
    const WITHDRAWAL_FEE = 0.10; // $0.10 USDC flat fee per external withdrawal
    const totalDeducted = withdrawAmount + WITHDRAWAL_FEE;

    if (withdrawAmount <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Amount must be positive" });
      return;
    }

    const { dbUser, claimedBalance } = await loadUserBalance(user.userId);

    if (dbUser?.transactionPasswordHash) {
      const txnPwd = typeof req.body.transactionPassword === "string" ? req.body.transactionPassword : "";
      if (!txnPwd) {
        res.status(403).json({ error: "Transaction password required", message: "Please enter your transaction password to authorize this withdrawal" });
        return;
      }
      const valid = await bcrypt.compare(txnPwd, dbUser.transactionPasswordHash);
      if (!valid) {
        res.status(403).json({ error: "Invalid transaction password", message: "The transaction password you entered is incorrect" });
        return;
      }
    }

    if (totalDeducted > claimedBalance) {
      res.status(400).json({
        error: "Insufficient balance",
        message: `You need at least $${totalDeducted.toFixed(2)} (amount + $${WITHDRAWAL_FEE.toFixed(2)} fee). Available: $${claimedBalance.toFixed(2)}.`,
      });
      return;
    }

    // Decide source wallet:
    //   • Real Circle DCW wallet (non platform-* ID):
    //       Check live Circle wallet balance first. If it covers the withdrawal,
    //       send from the user's own wallet (direct on-chain deposits).
    //       If the Circle wallet is short (e.g. balance came from Paystack/P2P which
    //       lands in the treasury, not the user's DCW wallet), fall back to treasury.
    //   • HD fallback wallet (platform-* ID):
    //       Always send from platform treasury (sweep worker moves HD USDC there).
    const hasRealCircleWallet =
      dbUser?.circleWalletAddress &&
      dbUser?.circleWalletId &&
      !dbUser.circleWalletId.startsWith("platform-");

    let sourceAddress: string | null = null;
    let sourceIsUserWallet = false;

    if (hasRealCircleWallet) {
      // Resolve the PRIMARY_BLOCKCHAIN wallet ID and check its live balance
      let dcwWalletId: string | null = null;
      const walletIdsJson = (dbUser as any).circleWalletIdsJson;
      if (walletIdsJson) {
        try {
          const idsMap = JSON.parse(walletIdsJson) as Record<string, string>;
          dcwWalletId = idsMap[PRIMARY_BLOCKCHAIN] ?? dbUser!.circleWalletId ?? null;
        } catch { dcwWalletId = dbUser!.circleWalletId ?? null; }
      } else {
        dcwWalletId = dbUser!.circleWalletId ?? null;
      }

      const circleWalletBalance = dcwWalletId
        ? parseFloat(await getWalletUsdcBalance(dcwWalletId))
        : 0;

      if (circleWalletBalance >= withdrawAmount) {
        sourceAddress = dbUser!.circleWalletAddress!;
        sourceIsUserWallet = true;
        req.log.info({ userId: user.userId, circleWalletBalance, withdrawAmount }, "[withdraw] Sending from user Circle wallet");
      } else {
        // Funds are in the treasury (Paystack/P2P credits) — fall back to it
        sourceAddress = getPlatformWalletAddress();
        req.log.info({ userId: user.userId, circleWalletBalance, withdrawAmount }, "[withdraw] Circle wallet insufficient — falling back to treasury");
      }
    } else {
      sourceAddress = getPlatformWalletAddress();
    }

    if (!sourceAddress) {
      res.status(503).json({ error: "Not configured", message: "No source wallet available for withdrawal" });
      return;
    }

    // Deduct amount + fee optimistically — roll back if transfer fails
    const newBalance = (claimedBalance - totalDeducted).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    let txHash: string | undefined;
    try {
      txHash = await circleTransferUsdc(
        sourceAddress,
        walletAddress,
        PRIMARY_BLOCKCHAIN,
        PRIMARY_USDC_ADDRESS,
        amount,
      );
      req.log.info({ txHash, amount, walletAddress, blockchain: PRIMARY_BLOCKCHAIN, source: sourceIsUserWallet ? "user-wallet" : "treasury" }, "[withdraw] Circle USDC transfer initiated");
    } catch (chainError: any) {
      await db.update(usersTable).set({ claimedBalance: claimedBalance.toFixed(6) }).where(eq(usersTable.id, user.userId));
      req.log.error({ err: chainError.message, amount, walletAddress }, "[withdraw] Transfer failed — balance restored");
      res.status(502).json({ error: "Transfer failed", message: chainError.message });
      return;
    }

    // Collect the $0.10 fee:
    //   • Sent from user's own Circle wallet → transfer fee to platform treasury
    //   • Sent from treasury (HD users or DCW fallback) → fee is already in treasury
    //     (deducted from claimedBalance but not sent out — no second transfer needed)
    if (sourceIsUserWallet) {
      const platformAddress = getPlatformWalletAddress();
      if (platformAddress) {
        try {
          await circleTransferUsdc(
            sourceAddress,
            platformAddress,
            PRIMARY_BLOCKCHAIN,
            PRIMARY_USDC_ADDRESS,
            WITHDRAWAL_FEE.toFixed(6),
          );
          req.log.info({ userId: user.userId, fee: WITHDRAWAL_FEE }, "[withdraw] Fee collected to treasury");
        } catch (feeErr: any) {
          // Non-fatal — main withdrawal already succeeded; log and continue
          req.log.warn({ err: feeErr.message, userId: user.userId }, "[withdraw] Fee collection failed — manual recovery needed");
        }
      }
    }

    await db.insert(withdrawalsTable).values({
      userId: user.userId,
      amount,
      type: "crypto",
      destination: walletAddress,
      status: "completed",
      txHash: txHash ?? null,
      completedAt: new Date(),
    });

    res.json({
      txHash: txHash ?? null,
      amount,
      fee: WITHDRAWAL_FEE.toFixed(2),
      newBalance,
      blockchain: PRIMARY_BLOCKCHAIN,
      message: `Withdrew ${withdrawAmount.toFixed(2)} USDC to ${walletAddress} on ${PRIMARY_BLOCKCHAIN}`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[withdraw] Crypto withdrawal error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/withdraw/fiat ──────────────────────────────────────────────────
router.post("/fiat", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const parsed = WithdrawFiatBodySecure.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { amount, bankAccountNumber, routingNumber, accountHolderName, country } = parsed.data as any;
    const withdrawAmount = parseFloat(amount);

    if (withdrawAmount <= 0) {
      res.status(400).json({ error: "Invalid amount", message: "Amount must be positive" });
      return;
    }

    const { claimedBalance } = await loadUserBalance(user.userId);

    if (withdrawAmount > claimedBalance) {
      res.status(400).json({
        error: "Insufficient balance",
        message: `You only have $${claimedBalance.toFixed(2)} available. Requested $${withdrawAmount.toFixed(2)}.`,
      });
      return;
    }

    const newBalance = (claimedBalance - withdrawAmount).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    const { transferId, status } = await initiateWireTransfer(withdrawAmount.toFixed(2), {
      bankAccountNumber,
      routingNumber,
      accountHolderName,
      country: country ?? "US",
    });

    req.log.info({ transferId, status, amount }, "[withdraw] Circle payout initiated");

    await db.insert(withdrawalsTable).values({
      userId: user.userId,
      amount,
      type: "fiat",
      destination: `Bank ****${bankAccountNumber.slice(-4)} (routing: ${routingNumber})`,
      status: "pending",
      circleTransferId: transferId,
    });

    res.json({
      transferId,
      amount,
      status,
      newBalance,
      estimatedArrival: "1–3 business days",
      message: `Initiated $${withdrawAmount.toFixed(2)} USD wire transfer via Circle`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[withdraw] Fiat withdrawal error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
