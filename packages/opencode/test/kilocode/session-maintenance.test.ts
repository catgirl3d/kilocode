import { Database as SQLite } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import * as Maintenance from "../../src/kilocode/session/maintenance"
import { tmpdir } from "../fixture/fixture"

const use = <A, E>(file: string, effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(Effect.provide(Database.layerFromPath(file))(Effect.scoped(effect)))

const now = 10_000_000
const old = now - 8 * 24 * 60 * 60 * 1000

function row(id: string, parentID: string | null, updated = old): Maintenance.Row {
  return { id, parentID, title: id, directory: "/repo", updated }
}

describe("Kilo session maintenance", () => {
  test("selects stale leaf children while protecting the current ancestry", () => {
    const result = Maintenance.select(
      [
        row("root", null),
        row("current", "root"),
        row("stale-sibling", "root"),
        row("recent", "root", now),
        row("parent-with-child", "root"),
        row("nested", "parent-with-child"),
      ],
      { current: "current", ageDays: 7, now },
    )

    expect(result.map((item) => item.id)).toEqual(["stale-sibling", "nested"])
  })

  test("does not select root sessions", () => {
    const result = Maintenance.select([row("root", null)], { current: "other", ageDays: 1, now })

    expect(result).toEqual([])
  })

  test("supports cleanup without an active session context", () => {
    const result = Maintenance.select([row("root", null), row("child", "root")], { ageDays: 1, now })

    expect(result.map((item) => item.id)).toEqual(["child"])
  })

  test("characterizes compaction of a populated legacy file and disk reclaim", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "legacy.db")
    await use(
      file,
      Effect.gen(function* () {
        yield* Database.Service
      }),
    )

    const legacy = new SQLite(file)
    try {
      legacy.exec("PRAGMA auto_vacuum = NONE")
      legacy.exec("VACUUM")
      expect(legacy.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 })
      legacy.exec("CREATE TABLE compact_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
      const insert = legacy.query("INSERT INTO compact_probe (id, payload) VALUES (?, zeroblob(4096))")
      legacy.transaction(() => {
        for (const id of Array.from({ length: 1024 }, (_, index) => index + 1)) insert.run(id)
      })()
    } finally {
      legacy.close()
    }

    const state = await use(
      file,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const mode = yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
        const count = yield* db.get<{ count: number }>("SELECT count(*) AS count FROM compact_probe")
        yield* db.run("PRAGMA wal_autocheckpoint = 0")
        yield* db.run("DELETE FROM compact_probe WHERE id > 1")
        const free = yield* db.get<{ freelist_count: number }>("PRAGMA freelist_count")
        const before = { main: statSync(file).size, wal: statSync(`${file}-wal`).size }
        const compacted = yield* Maintenance.compact(db)
        const next = yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
        const left = yield* db.get<{ freelist_count: number }>("PRAGMA freelist_count")
        const after = { main: statSync(file).size, wal: statSync(`${file}-wal`).size }
        return { mode, count, free, before, compacted, next, left, after }
      }),
    )

    expect(state.mode?.auto_vacuum).toBe(0)
    expect(state.count?.count).toBe(1024)
    expect(state.free?.freelist_count).toBeGreaterThan(0)
    expect(state.before.wal).toBeGreaterThan(0)
    expect(state.compacted).toBe(true)
    expect(state.next?.auto_vacuum).toBe(2)
    expect(state.left?.freelist_count).toBe(0)
    expect(state.after.main).toBeLessThan(state.before.main)
    expect(state.after.wal).toBe(0)
  })

  test("characterizes retry after a second connection releases its WAL snapshot", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "reader.db")
    const result = await use(
      file,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run("PRAGMA busy_timeout = 50")
        yield* db.run("CREATE TABLE compact_probe (value INTEGER NOT NULL)")
        yield* db.run("INSERT INTO compact_probe VALUES (1)")
        const mode = yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
        const reader = new SQLite(file)
        try {
          reader.exec("BEGIN")
          expect(reader.query("SELECT count(*) AS count FROM compact_probe").get()).toEqual({ count: 1 })
          yield* db.run("INSERT INTO compact_probe VALUES (2)")
          expect(reader.query("SELECT count(*) AS count FROM compact_probe").get()).toEqual({ count: 1 })
          expect(yield* Maintenance.compact(db)).toBe(false)
          reader.exec("ROLLBACK")
          expect(yield* Maintenance.compact(db)).toBe(true)
        } finally {
          reader.close()
        }
        return mode?.auto_vacuum
      }),
    )

    expect(result).toBe(2)
  })
})
