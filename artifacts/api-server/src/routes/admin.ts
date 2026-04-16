import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  circleTransferUsdc,
  getWalletUsdcBalance,
  getPlatformWalletId,
  getPlatformWalletAddress,
  probeGasStationStatus,
  isGasStationEnabled,
  PRIMARY_BLOCKCHAIN,
  PRIMARY_USDC_ADDRESS,
  type SupportedBlockchain,
  SUPPORTED_BLOCKCHAINS,
} from "../lib/circle.js";
import { cctpBridgeToTreasury, getTreasuryBalancesAllChains } from "../lib/cctp.js";

const router: IRouter = Router();

// ─── Admin auth middleware ────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({ error: "Admin not configured", message: "ADMIN_SECRET env var is not set" });
    return;
  }
  const token = (req.headers.authorization ?? "").replace("Bearer ", "");
  if (!token || token !== adminSecret) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or missing admin secret" });
    return;
  }
  next();
}

// ─── GET /api/admin/balance ───────────────────────────────────────────────────
// Returns platform wallet USDC balance via Circle DCW.
router.get("/balance", requireAdmin, async (req, res) => {
  try {
    const walletId  = getPlatformWalletId();
    const address   = getPlatformWalletAddress();

    if (!walletId || !address) {
      res.status(503).json({ error: "Not configured", message: "CIRCLE_PLATFORM_WALLET_ID / CIRCLE_PLATFORM_WALLET_ADDRESS not set" });
      return;
    }

    const [usdcBalance] = await Promise.all([
      getWalletUsdcBalance(walletId),
      probeGasStationStatus(),
    ]);

    res.json({
      walletId,
      walletAddress:   address,
      blockchain:      PRIMARY_BLOCKCHAIN,
      usdcBalance,
      gasStation:      isGasStationEnabled() ? "enabled" : "disabled",
    });
  } catch (err: any) {
    req.log.error({ err }, "[admin] Balance check error");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ─── POST /api/admin/withdraw ─────────────────────────────────────────────────
// Sends USDC from the platform wallet to any address — for revenue withdrawal.
//
// Usage:
//   curl -X POST http://localhost:3001/api/admin/withdraw \
//     -H "Authorization: Bearer <ADMIN_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"destinationAddress":"0x...","amount":"100"}'
router.post("/withdraw", requireAdmin, async (req, res) => {
  try {
    const { destinationAddress, amount } = req.body as { destinationAddress?: string; amount?: string };

    if (!destinationAddress || !/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
      res.status(400).json({ error: "Validation error", message: "destinationAddress must be a valid EVM address" });
      return;
    }

    const numAmount = parseFloat(amount ?? "");
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: "Validation error", message: "amount must be a positive number" });
      return;
    }

    const platformAddress = getPlatformWalletAddress();
    if (!platformAddress) {
      res.status(503).json({ error: "Not configured", message: "CIRCLE_PLATFORM_WALLET_ADDRESS is not set" });
      return;
    }

    const txId = await circleTransferUsdc(
      platformAddress,
      destinationAddress,
      PRIMARY_BLOCKCHAIN,
      PRIMARY_USDC_ADDRESS,
      numAmount.toFixed(6),
    );

    req.log.info({ txId, destinationAddress, amount: numAmount }, "[admin] Revenue withdrawal initiated");

    res.json({
      txId,
      destinationAddress,
      amount: numAmount.toFixed(6),
      blockchain: PRIMARY_BLOCKCHAIN,
      message: `Initiated transfer of ${numAmount.toFixed(6)} USDC to ${destinationAddress} on ${PRIMARY_BLOCKCHAIN}`,
    });
  } catch (err: any) {
    req.log.error({ err }, "[admin] Withdraw error");
    res.status(502).json({ error: "Transfer failed", message: err.message });
  }
});

// ─── GET /api/admin/treasury-balances ────────────────────────────────────────
// Returns the USDC balance of the platform treasury on every supported chain.
// Reads directly from on-chain ERC-20 contracts — no Circle API call needed.
router.get("/treasury-balances", requireAdmin, async (req, res) => {
  try {
    const balances = await getTreasuryBalancesAllChains();
    res.json({ balances, primaryChain: PRIMARY_BLOCKCHAIN });
  } catch (err: any) {
    req.log.error({ err }, "[admin] Treasury balances error");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ─── POST /api/admin/cctp-bridge ─────────────────────────────────────────────
// Consolidates USDC from a non-primary treasury chain to BASE-SEPOLIA (or any
// specified destination) using Circle CCTP v1.
//
// Body: { sourceChain: "ETH-SEPOLIA" | "MATIC-AMOY", amount: "10.5" }
//       destChain defaults to PRIMARY_BLOCKCHAIN (BASE-SEPOLIA)
//
// This is a long-running operation (~1–3 min) — the endpoint kicks it off
// asynchronously and returns immediately with a jobId to track in logs.
//
// Prerequisites:
//   - CIRCLE_PLATFORM_WALLET_ID_<SOURCE_CHAIN> must be set (e.g. CIRCLE_PLATFORM_WALLET_ID_ETH_SEPOLIA)
//   - CIRCLE_PLATFORM_WALLET_ID_<DEST_CHAIN>   must be set
//   - CIRCLE_PLATFORM_WALLET_ADDRESS must be set (shared on-chain address)
//   - Gas Station must be enabled (CIRCLE_GAS_STATION_ENABLED=true) or gas-funded wallets
//
// Usage:
//   curl -X POST http://localhost:3001/api/admin/cctp-bridge \
//     -H "Authorization: Bearer <ADMIN_SECRET>" \
//     -H "Content-Type: application/json" \
//     -d '{"sourceChain":"ETH-SEPOLIA","amount":"10"}'
router.post("/cctp-bridge", requireAdmin, async (req, res) => {
  const { sourceChain, destChain: destChainParam, amount } = req.body as {
    sourceChain?: string;
    destChain?:   string;
    amount?:      string;
  };

  if (!sourceChain || !(SUPPORTED_BLOCKCHAINS as readonly string[]).includes(sourceChain)) {
    res.status(400).json({
      error: "Validation error",
      message: `sourceChain must be one of: ${SUPPORTED_BLOCKCHAINS.join(", ")}`,
    });
    return;
  }

  const destChain = (destChainParam ?? PRIMARY_BLOCKCHAIN) as SupportedBlockchain;
  if (!(SUPPORTED_BLOCKCHAINS as readonly string[]).includes(destChain)) {
    res.status(400).json({
      error: "Validation error",
      message: `destChain must be one of: ${SUPPORTED_BLOCKCHAINS.join(", ")}`,
    });
    return;
  }

  if (sourceChain === destChain) {
    res.status(400).json({ error: "Validation error", message: "sourceChain and destChain must be different" });
    return;
  }

  const numAmount = parseFloat(amount ?? "");
  if (isNaN(numAmount) || numAmount <= 0) {
    res.status(400).json({ error: "Validation error", message: "amount must be a positive number" });
    return;
  }

  const jobId = `cctp-${Date.now()}`;
  req.log.info({ jobId, sourceChain, destChain, amount: numAmount }, "[admin/cctp] Bridge job started");

  // Return immediately — bridge takes ~1–3 min to complete
  res.json({
    jobId,
    sourceChain,
    destChain,
    amount: numAmount.toFixed(6),
    message: `CCTP bridge started (jobId: ${jobId}). Monitor server logs for progress.`,
  });

  // Run bridge in background
  cctpBridgeToTreasury(sourceChain as SupportedBlockchain, destChain, numAmount.toFixed(6))
    .then((result) => {
      req.log.info({ jobId, ...result }, "[admin/cctp] Bridge completed successfully");
    })
    .catch((err: any) => {
      req.log.error({ jobId, sourceChain, destChain, amount: numAmount, err: err?.message }, "[admin/cctp] Bridge failed");
    });
});

export default router;
