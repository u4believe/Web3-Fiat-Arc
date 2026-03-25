import { pgTable, serial, integer, varchar, timestamp } from "drizzle-orm/pg-core";

// One-time nonces for replay-attack protection on /claim/sign → /claim/confirm.
// Each nonce is embedded in the backend signature; the contract (or backend) verifies
// the nonce is unused and not expired before accepting a claim.
export const claimNoncesTable = pgTable("claim_nonces", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  nonce: varchar("nonce", { length: 66 }).notNull().unique(), // 0x + 32-byte hex
  emailHash: varchar("email_hash", { length: 66 }).notNull(),
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
