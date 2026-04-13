import app from "./app";
import { logger } from "./lib/logger";
import { startPolygonIndexer, stopPolygonIndexer } from "./lib/polygonIndexer.js";
import { startRecurringWorker, stopRecurringWorker } from "./lib/recurringWorker.js";
import { startSweepWorker, stopSweepWorker } from "./lib/circleSweepWorker.js";
import { probeGasStationStatus } from "./lib/circle.js";
import { registerPaystackWebhook } from "./lib/paystack.js";

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

  // Probe Circle Gas Station status (non-blocking)
  probeGasStationStatus().catch(() => {});

  // Start the Circle DCW sweep worker (consolidates user USDC into platform wallet)
  startSweepWorker();
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down");
  stopPolygonIndexer();
  stopRecurringWorker();
  stopSweepWorker();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down");
  stopPolygonIndexer();
  stopRecurringWorker();
  stopSweepWorker();
  process.exit(0);
});
