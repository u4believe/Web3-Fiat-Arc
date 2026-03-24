import { pgTable, serial, text, timestamp, decimal } from "drizzle-orm/pg-core";

export const escrowBalancesTable = pgTable("escrow_balances", {
  id: serial("id").primaryKey(),
  emailHash: text("email_hash").notNull().unique(),
  amount: decimal("amount", { precision: 20, scale: 6 }).notNull().default("0"),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});

export type EscrowBalance = typeof escrowBalancesTable.$inferSelect;
