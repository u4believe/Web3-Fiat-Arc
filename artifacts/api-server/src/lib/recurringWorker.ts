import { db, recurringTransfersTable, escrowsTable, usersTable } from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { logger } from "./logger.js";
import { hashEmail, parseUsdcAmount } from "./escrow.js";
import { sendRecurringSuccessEmail, sendRecurringFailureEmail } from "./email.js";

export async function processRecurringTransfers() {
  try {
    const activeTasks = await db
      .select({
        recurring: recurringTransfersTable,
        user: usersTable,
      })
      .from(recurringTransfersTable)
      .innerJoin(usersTable, eq(usersTable.id, recurringTransfersTable.senderUserId))
      .where(
        and(
          eq(recurringTransfersTable.status, "active"),
          lte(recurringTransfersTable.nextRunAt, new Date())
        )
      );

    if (activeTasks.length === 0) return;

    for (const { recurring, user } of activeTasks) {
      if (recurring.endDate && new Date() >= recurring.endDate) {
        // Automatically end it
        await db.update(recurringTransfersTable)
          .set({ status: "completed" })
          .where(eq(recurringTransfersTable.id, recurring.id));
        continue;
      }

      const numAmount = parseFloat(recurring.amount);
      const currentBalance = parseFloat(user.claimedBalance ?? "0");

      let nextRunAt = new Date(recurring.nextRunAt);
      if (recurring.interval === "daily") {
        nextRunAt.setDate(nextRunAt.getDate() + 1);
      } else if (recurring.interval === "weekly") {
        nextRunAt.setDate(nextRunAt.getDate() + 7);
      } else if (recurring.interval === "monthly") {
        nextRunAt.setMonth(nextRunAt.getMonth() + 1);
      }
      
      // If it's been skipped for days, catch it up to the future
      while (nextRunAt <= new Date()) {
         if (recurring.interval === "daily") nextRunAt.setDate(nextRunAt.getDate() + 1);
         else if (recurring.interval === "weekly") nextRunAt.setDate(nextRunAt.getDate() + 7);
         else if (recurring.interval === "monthly") nextRunAt.setMonth(nextRunAt.getMonth() + 1);
      }

      if (currentBalance < numAmount) {
        // Insufficient balance, skip this interval
        await db.update(recurringTransfersTable)
          .set({ nextRunAt })
          .where(eq(recurringTransfersTable.id, recurring.id));
        
        // Send failure email
        try {
          await sendRecurringFailureEmail(
            recurring.senderEmail,
            recurring.amount,
            recurring.recipientEmail,
            currentBalance.toFixed(6),
            nextRunAt,
          );
        } catch (emailErr) {
          logger.warn({ err: emailErr }, "Failed to send recurring failure email");
        }
        logger.info({ senderEmail: recurring.senderEmail }, "Insufficient funds — recurring transfer skipped");
        continue;
      }

      // Sufficient balance: Deduct & Escrow
      const newBalance = (currentBalance - numAmount).toFixed(6);
      const emailHash = hashEmail(recurring.recipientEmail);

      try {
        await db.transaction(async (tx) => {
          await tx.update(usersTable)
            .set({ claimedBalance: newBalance })
            .where(eq(usersTable.id, user.id));

          await tx.insert(escrowsTable).values({
            senderAddress: user.email,
            recipientEmail: recurring.recipientEmail,
            emailHash,
            amount: numAmount.toFixed(6),
            amountWei: parseUsdcAmount(numAmount.toFixed(6)).toString(),
            status: "confirmed",
          });

          await tx.update(recurringTransfersTable)
            .set({ nextRunAt })
            .where(eq(recurringTransfersTable.id, recurring.id));
        });

        try {
          await sendRecurringSuccessEmail(
            recurring.senderEmail,
            recurring.amount,
            recurring.recipientEmail,
            newBalance,
            nextRunAt,
          );
        } catch (emailErr) {
          logger.warn({ err: emailErr }, "Failed to send recurring success email");
        }
        logger.info({ senderEmail: recurring.senderEmail }, "Recurring transfer executed successfully");

      } catch (txnError: any) {
        logger.error({ err: txnError }, "Recurring transaction failed");
      }
    }
  } catch (error: any) {
    logger.error({ err: error }, "[recurringWorker] Failed to process tasks");
  }
}

let workerInterval: ReturnType<typeof setInterval> | null = null;

export function startRecurringWorker() {
  if (workerInterval) return;
  // Check every 1 minute
  logger.info("Starting Recurring Transfers background worker...");
  workerInterval = setInterval(processRecurringTransfers, 60 * 1000);
  
  // Also run immediately on boot
  processRecurringTransfers();
}

export function stopRecurringWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    logger.info("Stopped recurring transfers worker");
  }
}
