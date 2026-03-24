import { pgTable, serial, text, timestamp, decimal, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const escrowsTable = pgTable("escrows", {
  id: serial("id").primaryKey(),
  senderAddress: text("sender_address").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  emailHash: text("email_hash").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  amountWei: text("amount_wei").notNull(),
  status: text("status").notNull().default("pending"), // pending, claimed, refunded, withdrawn
  txHash: text("tx_hash"),
  claimTxHash: text("claim_tx_hash"),
  recipientUserId: integer("recipient_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
});

export const insertEscrowSchema = createInsertSchema(escrowsTable).omit({ id: true, createdAt: true });
export type InsertEscrow = z.infer<typeof insertEscrowSchema>;
export type Escrow = typeof escrowsTable.$inferSelect;
