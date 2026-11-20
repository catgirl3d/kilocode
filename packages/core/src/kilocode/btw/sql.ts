// fork_change - new file
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../../session/sql"

export const BtwTable = sqliteTable(
  "kilo_btw",
  {
    id: text().notNull().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    thread_id: text().notNull(),
    status: text().notNull(),
    question: text().notNull(),
    answer: text().notNull().default(""),
    error: text(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [index("kilo_btw_session_time_idx").on(table.session_id, table.time_created)],
)
