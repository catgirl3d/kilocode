import { Effect } from "effect"
import { Instance } from "@/kilocode/instance"
import * as Tool from "@/tool/tool"
import * as Truncate from "@/tool/truncate" // fork_change
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { MemoryTool } from "@kilocode/kilo-memory/tool"

export const MemoryRecallTool = Tool.define(
  "kilo_memory_recall",
  Effect.gen(function* () {
    const memory = yield* MemoryService.Service
    const trunc = yield* Truncate.Service // fork_change
    return {
      description: MemoryTool.RecallDescription,
      parameters: MemoryTool.RecallParameters,
      // fork_change start - Resolve configured read limits for each tool invocation.
      execute: (params: MemoryTool.RecallParams, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const limits = yield* params.mode === "read" ? trunc.limits() : Effect.succeed(undefined)
          return yield* MemoryTool.recall({
            memory,
            params,
            ...(limits ? { limits } : {}),
            sessionID: ctx.sessionID,
            ctx: { directory: Instance.directory, worktree: Instance.worktree },
            ask: (request) => ctx.ask(request),
          }).pipe(Effect.catchIf(MemoryTool.failure, (err) => Effect.succeed(MemoryTool.error("recall", err))))
        }),
      // fork_change end
    }
  }),
)
