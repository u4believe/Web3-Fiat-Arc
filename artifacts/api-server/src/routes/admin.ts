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
} from "../lib/circle.js";

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

export default router;
