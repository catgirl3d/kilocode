import { Effect } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const DAY = 24 * 60 * 60 * 1000

export type Row = {
  id: string
  parentID: string | null
  title: string
  directory: string
  updated: number
}

export type Candidate = Row & {
  reason: "old-child"
}

export type CleanupResult = {
  inspected: number
  candidates: Candidate[]
  removed: string[]
  skipped: string[]
}

function blocked(rows: readonly Row[], current?: string) {
  const parents = new Map(rows.map((row) => [row.id, row.parentID]))
  const result = new Set<string>(current ? [current] : [])
  let next = current ? (parents.get(current) ?? null) : null
  while (next) {
    if (result.has(next)) break
    result.add(next)
    next = parents.get(next) ?? null
  }
  return result
}

export function select(rows: readonly Row[], input: { current?: string; ageDays: number; now: number }) {
  const cutoff = input.now - input.ageDays * DAY
  const parents = new Set(rows.flatMap((row) => (row.parentID ? [row.parentID] : [])))
  const deny = blocked(rows, input.current)
  return rows
    .filter((row) => row.parentID !== null && !parents.has(row.id) && row.updated < cutoff && !deny.has(row.id))
    .map((row) => ({ ...row, reason: "old-child" as const }))
}

export const load = Effect.fn("KiloSessionMaintenance.load")(function* (db: Database.Interface["db"]) {
  const rows = yield* db
    .select({
      id: SessionTable.id,
      parentID: SessionTable.parent_id,
      title: SessionTable.title,
      directory: SessionTable.directory,
      updated: SessionTable.time_updated,
    })
    .from(SessionTable)
    .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
    .all()
    .pipe(Effect.orDie)
  return rows
})

export const cleanup = Effect.fn("KiloSessionMaintenance.cleanup")(function* (input: {
  db: Database.Interface["db"]
  sessions: Session.Interface
  current?: string
  ageDays: number
  limit: number
}) {
  const rows = yield* load(input.db)
  const candidates = select(rows, { current: input.current, ageDays: input.ageDays, now: Date.now() }).slice(
    0,
    input.limit,
  )
  const removed: string[] = []
  const skipped: string[] = []

  for (const item of candidates) {
    const result = yield* input.sessions.remove(SessionID.make(item.id)).pipe(
      Effect.as(true),
      Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
    )
    if (!result) {
      skipped.push(item.id)
      continue
    }

    const left = yield* input.db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionID.make(item.id)))
      .get()
      .pipe(Effect.orDie)
    if (left) skipped.push(item.id)
    else removed.push(item.id)
  }

  return { inspected: rows.length, candidates, removed, skipped } satisfies CleanupResult
})

export const compact = Effect.fn("KiloSessionMaintenance.compact")(function* (db: Database.Interface["db"]) {
  yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
  yield* db.run("VACUUM").pipe(Effect.orDie)
})
