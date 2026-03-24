import { pgTable, serial, text, timestamp, decimal, bigint } from "drizzle-orm/pg-core";

export const chainTransactionsTable = pgTable("chain_transactions", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),            // deposit | claim
  txHash: text("tx_hash").notNull().unique(),
  emailHash: text("email_hash").notNull(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull(),
  senderAddress: text("sender_address"),   // set on deposits
  recipientAddress: text("recipient_address"), // set on claims
  blockNumber: bigint("block_number", { mode: "bigint" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ChainTransaction = typeof chainTransactionsTable.$inferSelect;
