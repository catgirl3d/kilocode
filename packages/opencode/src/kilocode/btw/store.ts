// fork_change - new file
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionID } from "@/session/schema"
import type { BtwItem, BtwStatus } from "./schema"

type Row = {
  id: string
  session_id: SessionID
  thread_id: string
  status: BtwStatus
  question: string
  answer: string
  error: string | null
  provider_id: string
  model_id: string
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  time_created: number
  time_completed: number | null
}

const LIMIT = 200
// The replayed history of one thread: its most recent done pairs.
const THREAD = 10

export namespace BtwStore {
  // A row still marked running that this process is not running was cut off by a restart.
  export function item(row: Row, live: (id: string) => boolean): BtwItem {
    const status = row.status === "running" && !live(row.id) ? "interrupted" : row.status
    return {
      id: row.id,
      sessionID: row.session_id,
      threadID: row.thread_id,
      status,
      question: row.question,
      answer: row.answer,
      ...(row.error == null ? {} : { error: row.error }),
      providerID: row.provider_id,
      modelID: row.model_id,
      cost: row.cost,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
      },
      time: { created: row.time_created, ...(row.time_completed == null ? {} : { completed: row.time_completed }) },
    }
  }

  export const insert = Effect.fn("BtwStore.insert")(function* (input: BtwItem) {
    const { db } = yield* Database.Service
    yield* db
      .run(
        sql`
        INSERT INTO kilo_btw (id, session_id, thread_id, status, question, answer, provider_id, model_id, time_created)
        VALUES (${input.id}, ${input.sessionID}, ${input.threadID}, ${input.status}, ${input.question}, ${input.answer},
                ${input.providerID}, ${input.modelID}, ${input.time.created})
      `,
      )
      .pipe(Effect.orDie)
  })

  // Writes the terminal state and adds the spend to the session total in one transaction.
  // A row that is already terminal is left as it is.
  export const finish = Effect.fn("BtwStore.finish")(function* (input: BtwItem) {
    const { db } = yield* Database.Service
    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            // The spend goes in only while the row is still running, so a repeated finish cannot add it twice.
            if (input.cost > 0)
              yield* tx.run(sql`
                UPDATE session SET cost = cost + ${input.cost}
                WHERE id = ${input.sessionID}
                  AND EXISTS (SELECT 1 FROM kilo_btw WHERE id = ${input.id} AND status = 'running')
              `)
            yield* tx.run(sql`
              UPDATE kilo_btw SET
                status = ${input.status}, answer = ${input.answer}, error = ${input.error ?? null},
                cost = ${input.cost}, tokens_input = ${input.tokens.input}, tokens_output = ${input.tokens.output},
                tokens_reasoning = ${input.tokens.reasoning}, tokens_cache_read = ${input.tokens.cache.read},
                tokens_cache_write = ${input.tokens.cache.write}, time_completed = ${input.time.completed ?? Date.now()}
              WHERE id = ${input.id} AND status = 'running'
            `)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })

  export const list = Effect.fn("BtwStore.list")(function* (sessionID: SessionID, live: (id: string) => boolean) {
    const { db } = yield* Database.Service
    const rows = yield* db
      .all<Row>(
        sql`
        SELECT * FROM (
          SELECT rowid AS seq, * FROM kilo_btw WHERE session_id = ${sessionID}
          ORDER BY time_created DESC, rowid DESC LIMIT ${LIMIT}
        ) ORDER BY time_created ASC, seq ASC
      `,
      )
      .pipe(Effect.orDie)
    return rows.map((row) => item(row, live))
  })

  // The last completed Q/A pairs of one thread, oldest first, for follow-up replay.
  export const thread = Effect.fn("BtwStore.thread")(function* (sessionID: SessionID, threadID: string) {
    const { db } = yield* Database.Service
    const rows = yield* db
      .all<Row>(
        sql`
        SELECT * FROM (
          SELECT rowid AS seq, * FROM kilo_btw
          WHERE session_id = ${sessionID} AND thread_id = ${threadID} AND status = 'done'
          ORDER BY time_created DESC, rowid DESC LIMIT ${THREAD}
        ) ORDER BY time_created ASC, seq ASC
      `,
      )
      .pipe(Effect.orDie)
    return rows.map((row) => item(row, () => false))
  })
}
