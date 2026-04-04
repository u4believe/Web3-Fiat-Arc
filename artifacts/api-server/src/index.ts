import app from "./app";
import { logger } from "./lib/logger";
import { startIndexer, stopIndexer } from "./lib/indexer.js";
import { startRecurringWorker, stopRecurringWorker } from "./lib/recurringWorker.js";
import { registerPaystackWebhook } from "./lib/paystack.js";
import { ensureCircleWebhookSubscription } from "./lib/circle.js";

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

  // Register Circle webhook to receive USDC deposit notifications across all networks
  const circleWebhookUrl = process.env.WEBHOOK_URL
    ? process.env.WEBHOOK_URL.replace("/paystack/webhook", "/circle/webhook")
    : null;
  if (circleWebhookUrl) {
    ensureCircleWebhookSubscription(circleWebhookUrl).catch((err) => {
      logger.warn({ err }, "Circle webhook registration error");
    });
  }

  // Start the blockchain event indexer in the background
  startIndexer().catch((err) => {
    logger.error({ err }, "Failed to start indexer");
  });

  // Start the recurring transfers worker
  startRecurringWorker();
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down");
  await stopIndexer();
  stopRecurringWorker();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down");
  await stopIndexer();
  stopRecurringWorker();
  process.exit(0);
});
