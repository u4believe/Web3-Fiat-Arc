import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const virtualAccountsTable = pgTable("virtual_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Which provider generated this account
  provider: text("provider").notNull(), // paystack | flutterwave | monnify

  // Account details shown to the user
  accountNumber: text("account_number").notNull(),
  accountName:   text("account_name").notNull(),
  bankName:      text("bank_name").notNull(),
  bankCode:      text("bank_code"),

  // Provider-side reference IDs for webhook lookup
  // Paystack:     customer_code (CUS_xxxx)
  // Flutterwave:  account_number (same as accountNumber, but stored for clarity)
  // Monnify:      accountReference
  providerRef:   text("provider_ref"),

  currency: text("currency").notNull().default("NGN"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VirtualAccount = typeof virtualAccountsTable.$inferSelect;
