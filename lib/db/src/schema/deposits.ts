import { pgTable, serial, text, timestamp, decimal, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const depositsTable = pgTable("deposits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  type: text("type").notNull(), // crypto, bank
  source: text("source").notNull(), // wallet address (crypto) or "Bank transfer" (bank)
  // status flow (bank): pending_transfer → awaiting_confirmation → completed | failed
  // status flow (crypto): pending → completed | failed
  status: text("status").notNull().default("pending_transfer"),
  depositReference: text("deposit_reference"),   // unique ref user includes in memo (ARC-XXXXXX)
  circlePaymentId: text("circle_payment_id"),    // Circle payment ID when webhook confirms
  txHash: text("tx_hash"),                       // on-chain tx hash for crypto deposits
  creditedAt: timestamp("credited_at"),          // when claimedBalance was updated
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDepositSchema = createInsertSchema(depositsTable).omit({ id: true, createdAt: true });
export type InsertDeposit = z.infer<typeof insertDepositSchema>;
export type Deposit = typeof depositsTable.$inferSelect;
