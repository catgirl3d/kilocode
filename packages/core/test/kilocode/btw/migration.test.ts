import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { block, line } from "../../../script/kilocode/migration"

const make = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const btwID = migrations.find((migration) => migration.id.endsWith("_kilocode_btw"))?.id
const upstream = migrations.filter((migration) => !migration.id.endsWith("_kilocode_btw"))

describe("btw migration", () => {
  test("adds kilo_btw and its index without changing existing session rows", async () => {
    expect(btwID).toBeDefined()
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.applyOnly(db, upstream)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_root', 'project', 'root', '/repo', 'Root', '1', 1, 1)`,
        )
        const before = yield* db.all(sql`SELECT * FROM session`)
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kilo_btw'`),
        ).toBeUndefined()

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kilo_btw'`)).toEqual({
          name: "kilo_btw",
        })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'kilo_btw_session_time_idx'`,
          ),
        ).toEqual({ name: "kilo_btw_session_time_idx" })
        expect(yield* db.all(sql`SELECT * FROM session`)).toEqual(before)
      }),
    )
  })

  test("upstream applyOnly without the btw migration keeps its journal entry and table", async () => {
    expect(btwID).toBeDefined()
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* DatabaseMigration.applyOnly(db, migrations)
        yield* DatabaseMigration.applyOnly(db, upstream)
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${btwID}`)).toEqual({ id: btwID })
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kilo_btw'`)).toEqual({
          name: "kilo_btw",
        })
      }),
    )
  })

  test("deletes btw rows when their session is deleted", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* make
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.applyOnly(db, migrations)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_root', 'project', 'root', '/repo', 'Root', '1', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO kilo_btw (id, session_id, thread_id, status, question, provider_id, model_id, time_created) VALUES ('btw_root', 'ses_root', 'btw_root', 'done', 'What changed?', 'anthropic', 'claude', 1)`,
        )
        expect(yield* db.get(sql`SELECT count(*) AS count FROM kilo_btw`)).toEqual({ count: 1 })

        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_root'`)

        expect(yield* db.get(sql`SELECT count(*) AS count FROM kilo_btw`)).toEqual({ count: 0 })
      }),
    )
  })

  test("generated btw migration only creates kilo_btw and its index", async () => {
    expect(btwID).toBeDefined()
    const text = await Bun.file(path.join(import.meta.dir, "../../../src/database/migration", `${btwID}.ts`)).text()
    expect(text).toContain("CREATE TABLE \\`kilo_btw\\`")
    expect(text.match(/CREATE (TABLE|INDEX)/g)).toEqual(["CREATE TABLE", "CREATE INDEX"])
    expect(text).not.toMatch(/\b(ALTER|DROP)\b/i)
  })

  test("marks the btw migration as a [fork] kilocode_change in the generated registry", () => {
    expect(line("20261119000000_kilocode_btw", "x")).toBe("x // kilocode_change - [fork] /btw")
  })

  test("leaves the btw migration file to its header and marks its statements [fork] only in the full schema", () => {
    const source = "CREATE TABLE `kilo_btw` (`id` text)"
    expect(block("20261119000000_kilocode_btw", source, "x")).toBe("x")
    expect(block(undefined, source, "x")).toBe("// kilocode_change start - [fork] /btw\nx\n// kilocode_change end")
    expect(block(undefined, "CREATE TABLE `kilo_board` (`id` text)", "x")).toBe(
      "// kilocode_change start\nx\n// kilocode_change end",
    )
  })
})
