import { describe, expect, test } from "bun:test"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { tmpdir } from "../fixture/tmpdir"

const read = (file: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const mode = yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
      const limit = yield* db.get<{ journal_size_limit: number }>("PRAGMA journal_size_limit")
      return { mode: mode?.auto_vacuum ?? 0, limit: limit?.journal_size_limit ?? -1 }
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )

describe("database tuning", () => {
  test("creates databases with incremental auto-vacuum and a bounded WAL", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "kilo.db")

    // auto_vacuum only takes effect when it is set before the file receives its first page, so
    // moving the pragma below `journal_mode = WAL` silently turns incremental vacuuming off.
    expect(await read(file)).toEqual({ mode: 2, limit: 64 * 1024 * 1024 })
    // journal_size_limit is a connection setting, so an existing file has to get it on every open.
    expect(await read(file)).toEqual({ mode: 2, limit: 64 * 1024 * 1024 })
  })
})
