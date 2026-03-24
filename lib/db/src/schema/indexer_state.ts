import { pgTable, integer, bigint, timestamp } from "drizzle-orm/pg-core";

export const indexerStateTable = pgTable("indexer_state", {
  id: integer("id").primaryKey().default(1),
  lastProcessedBlock: bigint("last_processed_block", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type IndexerState = typeof indexerStateTable.$inferSelect;
