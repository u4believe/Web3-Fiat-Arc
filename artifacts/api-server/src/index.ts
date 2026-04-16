import app from "./app";
import { logger } from "./lib/logger";
import { startPolygonIndexer, stopPolygonIndexer } from "./lib/polygonIndexer.js";
import { startRecurringWorker, stopRecurringWorker } from "./lib/recurringWorker.js";
import { probeGasStationStatus } from "./lib/circle.js";
import { registerPaystackWebhook } from "./lib/paystack.js";
import { stopCctpConsolidator } from "./lib/cctp.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Register Paystack webhook URL
  registerPaystackWebhook().catch((err) => {
    logger.warn({ err }, "Paystack webhook registration error");
  });

  // Start the USDC deposit indexer (Polygon Amoy, Base Sepolia, Ethereum Sepolia)
  startPolygonIndexer();

  // Start the recurring transfers worker
  startRecurringWorker();

  // CCTP consolidator — disabled on testnet: Circle's CCTP v1 contracts at the
  // standard testnet addresses have zero historical usage and depositForBurn reverts
  // consistently on ETH-SEPOLIA. Will be re-enabled when moving to mainnet.
  // startCctpConsolidator();

  // Probe Circle Gas Station status (non-blocking)
  probeGasStationStatus().catch(() => {});

});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down");
  stopPolygonIndexer();
  stopRecurringWorker();
  stopCctpConsolidator();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down");
  stopPolygonIndexer();
  stopRecurringWorker();
  stopCctpConsolidator();
  process.exit(0);
});
