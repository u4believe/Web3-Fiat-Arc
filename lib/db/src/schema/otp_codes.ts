import { pgTable, serial, integer, varchar, timestamp, boolean } from "drizzle-orm/pg-core";

export const otpCodesTable = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  code: varchar("code", { length: 6 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // "register" | "login"
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
