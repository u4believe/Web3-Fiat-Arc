// @ts-nocheck — this file is run by drizzle-kit directly, not compiled by tsc
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Supabase requires SSL — use verify-full (recommended by pg driver)
const dbUrl = process.env.DATABASE_URL.includes("sslmode")
  ? process.env.DATABASE_URL
  : process.env.DATABASE_URL + "?sslmode=verify-full";

export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
