import { pgTable, serial, text, timestamp, decimal, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailHash: text("email_hash").unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  walletAddress: text("wallet_address"),
  circleWalletId: text("circle_wallet_id"),
  circleWalletAddress: text("circle_wallet_address"),
  // JSON map of blockchain → Circle wallet ID for multi-chain deposit support
  // e.g. {"MATIC-AMOY":"uuid","BASE-SEPOLIA":"uuid","ETH-SEPOLIA":"uuid"}
  circleWalletIdsJson: text("circle_wallet_ids_json"),
  claimedBalance: decimal("claimed_balance", { precision: 20, scale: 6 }).notNull().default("0"),

  // ── Transaction password ───────────────────────────────────────────────────
  // A secondary password required to authorize outgoing transactions.
  // Stored as a bcrypt hash; never returned to the client.
  transactionPasswordHash: text("transaction_password_hash"),

  // ── Personal Authorization Key (PAK) ─────────────────────────────────────
  // A one-time-reveal 40-char alphanumeric key used to authorize password
  // changes. Stored only as a bcrypt hash (irreversible). The plaintext is
  // returned exactly once at generation time and never persisted.
  // Only the first 3 and last 4 characters are kept for user recognition.
  pakHash:      text("pak_hash"),
  pakPrefix:    text("pak_prefix"),    // first 3 chars — stored in plaintext
  pakSuffix:    text("pak_suffix"),    // last 4 chars  — stored in plaintext
  pakCreatedAt: timestamp("pak_created_at"),  // enforces the 6-month regeneration lock
  pakCopiedAt:  timestamp("pak_copied_at"),   // set when user confirms they've saved the key

  createdAt: timestamp("created_at").notNull().defaultNow(),
  emailVerified:           boolean("email_verified").notNull().default(false),
  emailVerificationToken:  text("email_verification_token"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, claimedBalance: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
