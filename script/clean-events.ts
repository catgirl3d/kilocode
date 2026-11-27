// kilocode_change - new file
// Offline cleanup for ~/.local/share/kilo/kilo.db.
// Default is a dry run. Nothing is modified without --yes.
//
// Usage:
//   bun script/clean-events.ts
//   bun script/clean-events.ts --yes
//   bun script/clean-events.ts --yes --backup-dir "D:/backups"
//
// What --yes does:
//   1. refuses to continue if another process has the DB open (exclusive lock, held until the script exits)
//   2. VACUUM INTO a timestamped backup next to the DB (or --backup-dir)
//   3. verifies the backup with pragma integrity_check
//   4. DELETE FROM event (all event journal rows; event_sequence is kept)
//   5. verifies session/message/part counts are unchanged
//   6. wal_checkpoint(TRUNCATE), VACUUM, final integrity_check/foreign_key_check
//
// The chat read model (session/message/part) is not touched. Viewing and
// continuing sessions keep working; replay/sync/workspace-warp history is gone.

import { Database } from "bun:sqlite"
import { existsSync, statSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const yes = args.includes("--yes")
const dirIndex = args.indexOf("--backup-dir")
const backupDir = dirIndex >= 0 ? args[dirIndex + 1] : undefined

const dataDir = join(homedir(), ".local", "share", "kilo")
const dbPath = join(dataDir, "kilo.db")
const walPath = `${dbPath}-wal`
const shmPath = `${dbPath}-shm`

const bytes = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}
const size = (path) => (existsSync(path) ? statSync(path).size : 0)
const quote = (path) => path.replaceAll("\\", "/").replaceAll("'", "''")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const backupPath = join(backupDir ?? dataDir, `kilo.db.backup-${stamp}`)
const fail = (message) => {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}
const abort = (message) => fail(`${message}. The DB was not restored; the pre-cleanup backup is ${backupPath}`)
const free = (path) => {
  const stat = statfsSync(path)
  return stat.bavail * stat.bsize
}

if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`)

const db = new Database(dbPath, { readonly: true })
const page = db.query("pragma page_size").get()
const pages = db.query("pragma page_count").get()
const freelist = db.query("pragma freelist_count").get()
const count = (table) => db.query(`select count(*) as c from "${table}"`).get().c
const before = {
  session: count("session"),
  message: count("message"),
  part: count("part"),
  event: count("event"),
  sequence: count("event_sequence"),
}
db.close()

const dbSize = size(dbPath)
console.log("Kilo event journal cleanup")
console.log(`db:        ${dbPath}`)
console.log(`size:      ${bytes(dbSize)} (${pages.page_count} pages x ${page.page_size})`)
console.log(`free pages:${freelist.freelist_count}`)
console.log(`wal:       ${bytes(size(walPath))}`)
console.log(`shm:       ${bytes(size(shmPath))}`)
console.log(
  `rows:      session=${before.session} message=${before.message} part=${before.part} event=${before.event} event_sequence=${before.sequence}`,
)
console.log(`free:      ${bytes(free(dataDir))} next to the DB`)
console.log(`backup to: ${backupPath}`)

if (!yes) {
  console.log("\nDRY RUN: nothing changed. Re-run with --yes to delete all event rows and VACUUM.")
  process.exit(0)
}

const backupTarget = backupDir ?? dataDir
const backupFree = free(backupTarget)
if (backupFree < dbSize) fail(`not enough free space for backup: need ${bytes(dbSize)}, have ${bytes(backupFree)}`)
const dbFree = free(dataDir)
const vacuumNeed = Math.ceil(dbSize * 0.65)
const sameDir = backupTarget === dataDir
const needHere = sameDir ? dbSize + vacuumNeed + 1024 ** 3 : vacuumNeed
const temp =
  process.platform === "win32" ? "set TMP and TEMP to a folder on another drive" : "set SQLITE_TMPDIR to another drive"
if (dbFree < needHere)
  fail(
    `not enough free space next to the DB: need about ${bytes(needHere)} (backup + VACUUM temp), have ${bytes(dbFree)}. ` +
      `Free space, move the backup with --backup-dir, or ${temp} before running.`,
  )

const work = new Database(dbPath)
try {
  work.exec("PRAGMA locking_mode = EXCLUSIVE")
  work.exec("BEGIN EXCLUSIVE")
  work.exec("COMMIT")
} catch (err) {
  fail(`database is open in another process (${err}): close VS Code / Kilo (all windows and the kilo serve process) and run again`)
}
const checkpoint = work.query("pragma wal_checkpoint(truncate)").get()
if (checkpoint.busy !== 0)
  fail("database is busy: close VS Code / Kilo (all windows and the kilo serve process) and run again")
if (existsSync(backupPath)) fail(`backup path already exists: ${backupPath}`)

console.log("\n1/5 backup")
work.exec(`VACUUM INTO '${quote(backupPath)}'`)
const check = new Database(backupPath, { readonly: true })
const integrity = check.query("pragma integrity_check").get().integrity_check
check.close()
if (integrity !== "ok") fail(`backup integrity_check failed: ${integrity}`)
console.log(`  backup ok: ${bytes(size(backupPath))}`)

console.log("2/5 delete event rows")
work.exec("PRAGMA foreign_keys = ON")
const batch = 50000
let deleted = 0
let passes = 0
while (true) {
  const result = work.query(`DELETE FROM event WHERE rowid IN (SELECT rowid FROM event LIMIT ${batch})`).run()
  deleted += result.changes
  passes += 1
  if (result.changes < batch) break
  if (passes % 10 === 0) {
    work.query("pragma wal_checkpoint(passive)").get()
    console.log(`  deleted ${deleted} rows...`)
  }
}

const afterDelete = {
  session: work.query('select count(*) as c from "session"').get().c,
  message: work.query('select count(*) as c from "message"').get().c,
  part: work.query('select count(*) as c from "part"').get().c,
  event: work.query('select count(*) as c from "event"').get().c,
  sequence: work.query('select count(*) as c from "event_sequence"').get().c,
}
if (afterDelete.event !== 0) abort(`event table still has ${afterDelete.event} rows`)
if (afterDelete.sequence !== before.sequence) abort("event_sequence changed unexpectedly")
if (
  afterDelete.session !== before.session ||
  afterDelete.message !== before.message ||
  afterDelete.part !== before.part
)
  abort("session/message/part counts changed unexpectedly")
console.log(`  deleted ${before.event} rows; projections unchanged`)

console.log("3/5 checkpoint + VACUUM")
work.query("pragma wal_checkpoint(truncate)").get()
work.exec("VACUUM")
work.query("pragma wal_checkpoint(truncate)").get()

console.log("4/5 checks")
const finalIntegrity = work.query("pragma integrity_check").get().integrity_check
if (finalIntegrity !== "ok") abort(`final integrity_check failed: ${finalIntegrity}`)
const fk = work.query("pragma foreign_key_check").all()
if (fk.length > 0) abort(`foreign_key_check returned ${fk.length} rows`)
const finalPages = work.query("pragma page_count").get().page_count
console.log(`  integrity ok, foreign keys ok`)

console.log("5/5 done")
work.close()
console.log(`before: ${bytes(dbSize)}`)
console.log(`after:  ${bytes(size(dbPath))} (${finalPages} pages)`)
console.log(`wal:    ${bytes(size(walPath))}`)
console.log(`backup: ${backupPath}`)
console.log("\nStart VS Code / Kilo again. Sessions open and continue from message/part as before.")
