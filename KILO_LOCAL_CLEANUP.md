# Kilo DB: Maintenance and Cleanup

DB: `%USERPROFILE%\.local\share\kilo\kilo.db` on Windows or `~/.local/share/kilo/kilo.db` on Unix.
Exact path: `kilo --pure db path`.
Log cleanup script: `script/clean-events.ts`.

## Important

- Before doing any work, close VS Code / Kilo: all windows and `kilo serve` processes.
- `kilo.db-wal` and `kilo.db-shm` are parts of the same DB, not separate copies. Do not delete them manually.
- `KILO_DISABLE_CHANNEL_DB=1` is required; otherwise a local build opens the channel DB (`kilo-<channel>.db`) instead of the main history.
- Do not delete `event_sequence`: it prevents event numbers from being reused.
- It is better to place the backup on another drive. `VACUUM` writes a temporary copy to the system temp directory; on Windows this is `TMP`/`TEMP`, and `SQLITE_TMPDIR` is not used there.
- The script expects the default `~/.local/share/kilo` directory; if `XDG_DATA_HOME` is overridden, update `dataDir` in `script/clean-events.ts`.

## Regular Session Cleanup

PowerShell:

```powershell
$env:KILO_DISABLE_CHANNEL_DB = "1"

# preview, deletes nothing
kilo --pure db path
kilo --pure session cleanup --older-than 7 --limit 1000

# batch deletion; repeat until candidates reaches 0
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes

# final pass with compaction
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes --vacuum
```

bash:

```bash
export KILO_DISABLE_CHANNEL_DB=1
kilo --pure db path
kilo --pure session cleanup --older-than 7 --limit 1000
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes
kilo --pure session cleanup --older-than 7 --limit 1000 --apply --yes --vacuum
```

## Cleaning Up the `event` Log

`event` is an append-only log; in one run it was estimated to take around 7 GB out of 14 GB. Deleting all `event` rows does not break viewing or continuing chats, because those read `message`/`part`. Replay and sync break (see below).

Run only with Kilo completely closed, from the repository root:

```powershell
bun .\script\clean-events.ts --yes

# backup to another drive:
bun .\script\clean-events.ts --yes --backup-dir "<backup-dir>"
```

`<backup-dir>` is an existing directory; the script does not create it and checks free space via `statfsSync`.

What the script does:

1. Checks that the DB is not busy (`wal_checkpoint(TRUNCATE)`, `busy`).
2. Creates a consistent backup via `VACUUM INTO` and verifies it with `integrity_check`.
3. Deletes all `event` rows in batches of 50,000.
4. Verifies that `session`/`message`/`part` and `event_sequence` did not change.
5. Runs `wal_checkpoint(TRUNCATE)`, `VACUUM`, and final `integrity_check` and `foreign_key_check`.
6. Prints before/after sizes and the backup path.

Example from one run (numbers depend on history, but give a sense of scale):

| Metric | Before | After |
|---|---:|---:|
| `kilo.db` | 13.98 GiB | 4.73 GiB |
| `event` | 3,164,138 rows | 0 |
| `kilo.db-wal` | 4.0 MiB | 0 B |
| `event_sequence` | 1,835 | 1,835 (unchanged) |
| pre-deletion backup | — | 13.98 GiB |

Around 9.25 GiB freed; `session`/`message`/`part` were unchanged.

## Post-Cleanup Verification

PowerShell:

```powershell
$db = kilo --pure db path
sqlite3 -readonly "$db" "select count(*) from event; select count(*) from event_sequence;"
```

bash:

```bash
db="$(kilo --pure db path)"
sqlite3 -readonly "$db" "select count(*) from event; select count(*) from event_sequence;"
```

Expected: `event = 0`, `event_sequence` unchanged. Then open Kilo, open an old session, check messages/tool calls, continue it with a new message, and create a new session.

## What Is Broken After Deleting `event` (Accepted)

- replay of cleaned aggregates fails closed (`Replay diverged` / `Sequence mismatch`);
- `/sync/history` and experimental remote workspace sync/warp/copy;
- v2 `GET /api/session/{id}/history` and `/event` return empty for cleaned sessions.

Unaffected: regular chat, session continuation, compaction/revert/fork/import/export, hosted Cloud copy/continue, live SSE.

## Do Not

- do not delete `kilo.db-wal` / `kilo.db-shm` manually;
- do not delete `event_sequence`;
- do not run `DELETE`/`VACUUM` while Kilo is open.
