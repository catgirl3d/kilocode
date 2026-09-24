// fork_change - new file
import { Effect } from "effect"
import type { Database } from "../database/database"

type Db = Database.Interface["db"]

/** Size the write-ahead log is truncated to once a checkpoint resets it. */
const WAL_LIMIT = 64 * 1024 * 1024

/**
 * Keeps the SQLite file from holding disk space it no longer needs.
 *
 * `journal_size_limit` is a connection setting, so it is not stored in the database file and has
 * to be applied on every open. Without it the WAL keeps its high-water mark for the lifetime of the
 * file: a single VACUUM on a large database leaves a multi-gigabyte `-wal` next to it, and only a
 * truncating checkpoint (or closing the last connection) releases it.
 *
 * `auto_vacuum` is stored in the file, but SQLite only honours the change while the database is
 * still empty, so this has to run before the first write - `PRAGMA journal_mode = WAL` alone
 * already initializes page 1 and makes the database non-empty. Existing files keep their current
 * mode until a VACUUM converts them; after that `PRAGMA incremental_vacuum` returns freed pages to
 * the filesystem without rewriting the whole file.
 */
export function tune(db: Db) {
  return Effect.gen(function* () {
    yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
    yield* db.run(`PRAGMA journal_size_limit = ${WAL_LIMIT}`)
  })
}
