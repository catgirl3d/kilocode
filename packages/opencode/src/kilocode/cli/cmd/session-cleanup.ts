import type { Argv } from "yargs"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Maintenance from "@/kilocode/session/maintenance"
import { Session } from "@/session/session"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { UI } from "@/cli/ui"

function valid(input: number, min: number, max: number) {
  return Number.isInteger(input) && input >= min && input <= max
}

export const KiloSessionCleanupCommand = effectCmd({
  command: "cleanup",
  describe: "preview or remove stale child sessions",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("older-than", {
        describe: "only target child sessions older than N days",
        type: "number",
        default: 7,
      })
      .option("limit", {
        describe: "maximum number of child sessions to remove in one run",
        type: "number",
        default: 100,
      })
      .option("apply", {
        describe: "perform deletion; without this flag the command is a dry-run",
        type: "boolean",
        default: false,
      })
      .option("yes", {
        describe: "confirm the requested deletion",
        type: "boolean",
        default: false,
      })
      .option("vacuum", {
        describe: "compact SQLite after deletion",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.session.cleanup")(function* (args) {
    if (!valid(args["older-than"], 1, 3650)) return yield* fail("--older-than must be an integer from 1 to 3650")
    if (!valid(args.limit, 1, 1000)) return yield* fail("--limit must be an integer from 1 to 1000")
    if (args.apply && !args.yes) return yield* fail("Deletion requires both --apply and --yes")
    if (args.vacuum && (!args.apply || !args.yes)) return yield* fail("--vacuum requires --apply --yes")

    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const rows = yield* Maintenance.load(database.db)
    const all = Maintenance.select(rows, { ageDays: args["older-than"], now: Date.now() })
    const candidates = all.slice(0, args.limit)

    UI.println(
      JSON.stringify(
        {
          mode: args.apply ? "apply" : "dry-run",
          olderThan: args["older-than"],
          inspected: rows.length,
          candidates: all.length,
          selected: candidates.length,
          limit: args.limit,
          sessions: candidates.slice(0, 25).map((item) => ({
            id: item.id,
            parentID: item.parentID,
            title: item.title,
            updated: new Date(item.updated).toISOString(),
          })),
        },
        null,
        2,
      ),
    )

    if (!args.apply) return

    const result = yield* Maintenance.cleanup({
      db: database.db,
      sessions,
      ageDays: args["older-than"],
      limit: args.limit,
    })
    UI.println(`Removed ${result.removed.length} child sessions; skipped ${result.skipped.length}.`)

    if (args.vacuum) {
      yield* Maintenance.compact(database.db)
      UI.println("SQLite checkpoint and VACUUM completed.")
    }
  }),
})
