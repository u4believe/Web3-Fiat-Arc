import { pgTable, serial, text, timestamp, decimal, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const withdrawalsTable = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  type: text("type").notNull(), // crypto, fiat
  destination: text("destination").notNull(), // wallet address or bank account
  status: text("status").notNull().default("pending"), // pending, completed, failed
  txHash: text("tx_hash"),
  circleTransferId: text("circle_transfer_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertWithdrawalSchema = createInsertSchema(withdrawalsTable).omit({ id: true, createdAt: true });
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type Withdrawal = typeof withdrawalsTable.$inferSelect;
