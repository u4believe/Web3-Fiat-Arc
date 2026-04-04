import { pgTable, serial, text, timestamp, decimal, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recurringTransfersTable = pgTable("recurring_transfers", {
  id: serial("id").primaryKey(),
  senderUserId: integer("sender_user_id").notNull(),
  senderEmail: text("sender_email").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  interval: text("interval").notNull(), // 'daily', 'weekly', 'monthly'
  nextRunAt: timestamp("next_run_at").notNull(),
  endDate: timestamp("end_date"),
  status: text("status").notNull().default("active"), // 'active', 'completed', 'cancelled'
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRecurringTransferSchema = createInsertSchema(recurringTransfersTable).omit({ id: true, createdAt: true });
export type InsertRecurringTransfer = z.infer<typeof insertRecurringTransferSchema>;
export type RecurringTransfer = typeof recurringTransfersTable.$inferSelect;
