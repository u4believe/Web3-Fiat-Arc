import { Router, type IRouter } from "express";
import { db, usersTable, withdrawalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { ethers } from "ethers";
import { requireAuth, requireEmailVerified } from "../lib/auth.js";
import {
  circleTransferUsdc,
  getPlatformWalletAddress,
  getPlatformWalletIdForChain,
  initiateWireTransfer,
  PRIMARY_BLOCKCHAIN,
  PRIMARY_USDC_ADDRESS,
  SUPPORTED_BLOCKCHAINS,
  type SupportedBlockchain,
} from "../lib/circle.js";
import { WithdrawCryptoBody, WithdrawFiatBodySecure } from "@workspace/api-zod";

// ─── Multi-chain treasury balance lookup ─────────────────────────────────────
// CCTP cross-chain bridging is not functional on these testnet deployments, so
// withdrawals fall through to the first chain treasury that has enough USDC.
// Order: PRIMARY_BLOCKCHAIN first, then remaining chains.

const CHAIN_RPC_URLS: Record<string, string> = {
  "ETH-SEPOLIA":  process.env.ETH_SEPOLIA_RPC_URL  ?? "https://ethereum-sepolia-rpc.publicnode.com",
  "BASE-SEPOLIA": process.env.BASE_SEPOLIA_RPC_URL  ?? "https://sepolia.base.org",
  "MATIC-AMOY":   process.env.POLYGON_AMOY_RPC_URL  ?? "https://rpc-amoy.polygon.technology/",
};

const CHAIN_USDC_ADDRESSES: Record<string, string> = {
  "ETH-SEPOLIA":  (process.env.ETH_SEPOLIA_USDC_ADDRESS  ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").toLowerCase(),
  "BASE-SEPOLIA": (process.env.BASE_USDC_ADDRESS          ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e").toLowerCase(),
  "MATIC-AMOY":   (process.env.POLYGON_AMOY_USDC_ADDRESS  ?? "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582").toLowerCase(),
};

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

async function getOnChainBalance(chain: string, address: string): Promise<number> {
  try {
    const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URLS[chain]);
    const contract = new ethers.Contract(CHAIN_USDC_ADDRESSES[chain], ERC20_BALANCE_ABI, provider);
    const raw: bigint = await contract.balanceOf(address);
    return parseFloat(ethers.formatUnits(raw, 6));
  } catch {
    return 0;
  }
}

/**
 * Find the first chain treasury with enough USDC to cover the withdrawal amount.
 * PRIMARY_BLOCKCHAIN is checked first. Returns null if no chain has enough.
 */
async function findSourceChain(amount: number): Promise<SupportedBlockchain | null> {
  const platformAddress = getPlatformWalletAddress();
  if (!platformAddress) return null;

  // Check primary chain first, then all others
  const orderedChains: SupportedBlockchain[] = [
    PRIMARY_BLOCKCHAIN,
    ...SUPPORTED_BLOCKCHAINS.filter((c) => c !== PRIMARY_BLOCKCHAIN),
  ];

  for (const chain of orderedChains) {
    // Skip chains where the platform wallet ID isn't configured — can't send without it
    if (!getPlatformWalletIdForChain(chain)) continue;

    const balance = await getOnChainBalance(chain, platformAddress);
    if (balance >= amount) {
      return chain;
    }
  }
  return null;
}

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
router.post("/crypto", requireAuth, requireEmailVerified, async (req, res) => {
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

    // ── Resolve source wallet ────────────────────────────────────────────────
    // Gas Station is NOT active — only the platform treasury wallet has ETH to
    // pay gas fees. User wallets hold deposited USDC but cannot pay gas.
    // The treasury is funded by the sweep worker (user USDC swept → treasury).
    const platformAddress = getPlatformWalletAddress();
    if (!platformAddress) {
      res.status(503).json({ error: "Not configured", message: "Platform treasury wallet is not configured." });
      return;
    }

    const sourceChain = await findSourceChain(withdrawAmount);
    if (!sourceChain) {
      res.status(400).json({
        error: "Insufficient treasury balance",
        message: `Platform treasury does not have enough USDC to cover $${withdrawAmount.toFixed(2)}. Please try a smaller amount or contact support.`,
      });
      return;
    }

    const sourceAddress = platformAddress;

    const usdcAddress = CHAIN_USDC_ADDRESSES[sourceChain] ?? PRIMARY_USDC_ADDRESS;

    // Deduct amount + fee optimistically — roll back if transfer fails
    const newBalance = (claimedBalance - totalDeducted).toFixed(6);
    await db.update(usersTable).set({ claimedBalance: newBalance }).where(eq(usersTable.id, user.userId));

    let txHash: string | undefined;
    try {
      txHash = await circleTransferUsdc(
        sourceAddress,
        walletAddress,
        sourceChain,
        usdcAddress,
        amount,
      );
      req.log.info({ txHash, amount, walletAddress, blockchain: sourceChain, source: "treasury" }, "[withdraw] Circle USDC transfer initiated");
    } catch (chainError: any) {
      await db.update(usersTable).set({ claimedBalance: claimedBalance.toFixed(6) }).where(eq(usersTable.id, user.userId));
      req.log.error({ err: chainError.message, amount, walletAddress, sourceChain }, "[withdraw] Transfer failed — balance restored");
      res.status(502).json({ error: "Transfer failed", message: chainError.message });
      return;
    }

    // The $0.10 fee was already deducted from claimedBalance above.
    // It stays as platform revenue in the DB — no second on-chain transaction needed.

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
      blockchain: sourceChain,
      message: `Withdrew ${withdrawAmount.toFixed(2)} USDC to ${walletAddress} on ${sourceChain}`,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[withdraw] Crypto withdrawal error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/withdraw/fiat ──────────────────────────────────────────────────
router.post("/fiat", requireAuth, requireEmailVerified, async (req, res) => {
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
