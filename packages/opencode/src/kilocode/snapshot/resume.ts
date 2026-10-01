// fork_change - new file
import path from "path"
import type { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { KiloSnapshotMutation } from "./mutation"
import type { KiloSnapshotGate } from "./gate"
import type { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { Shell } from "@opencode-ai/core/shell"
import { ShellPermission } from "@/tool/shell"
import { Effect } from "effect"

export namespace KiloSnapshotResume {
  export const restoreHistory = Effect.fn("KiloSnapshotResume.restoreHistory")(function* (input: {
    sessionID: SessionID
    resumeID: MessageID
    owner: KiloSnapshotGate.Owner
    sessions: Pick<Session.Interface, "messages">
    config: Pick<Config.Interface, "get">
    shellPermission: Effect.Success<typeof ShellPermission>
  }) {
    const history = yield* input.sessions.messages({ sessionID: input.sessionID })
    const groups = new Set<MessageID>()
    const seen = new Set<MessageID>()
    let id: MessageID | undefined = input.resumeID
    let baseline: string | undefined
    while (id && !seen.has(id)) {
      seen.add(id)
      const message = history.find((item) => item.info.role === "assistant" && item.info.id === id)
      if (message?.info.role !== "assistant" || !message.info.parentID) break
      const parentID = message.info.parentID
      if (groups.has(parentID)) break
      groups.add(parentID)
      baseline = history
        .filter((item) => item.info.role === "assistant" && item.info.parentID === parentID)
        .flatMap((item) => item.parts)
        .find(
          (part): part is MessageV2.StepStartPart => part.type === "step-start" && Boolean(part.snapshot),
        )?.snapshot
      if (baseline) break
      const user = history.find((item) => item.info.role === "user" && item.info.id === parentID)
      const source = user?.parts.find(
        (part) =>
          part.type === "text" &&
          part.synthetic &&
          part.metadata?.background === true &&
          typeof part.metadata.sourceMessageID === "string",
      )
      id = source?.type === "text" ? (source.metadata?.sourceMessageID as MessageID | undefined) : undefined
    }
    const attempted =
      !baseline &&
      (yield* Effect.gen(function* () {
        const ctx = yield* Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cfg = yield* input.config.get()
          return { instance, shell: Shell.acceptable(cfg.shell) }
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        for (const item of history) {
          if (item.info.role !== "assistant" || !groups.has(item.info.parentID)) continue
          for (const part of item.parts) {
            if (part.type !== "tool" || part.state.status === "pending") continue
            const access = yield* Effect.gen(function* () {
              if (part.tool !== "bash" || typeof part.state.input.command !== "string" || !ctx) return undefined
              const cwd = path.resolve(
                ctx.instance.directory,
                typeof part.state.input.workdir === "string" ? part.state.input.workdir : ".",
              )
              return yield* input.shellPermission.snapshotAccess({
                command: part.state.input.command,
                cwd,
                shell: ctx.shell,
              })
            }).pipe(Effect.catchCause(() => Effect.succeed("unknown" as const)))
            if (KiloSnapshotMutation.mayMutate({ tool: part.tool, args: part.state.input, shell: access }))
              return true
          }
        }
        return false
      }))
    yield* input.owner.restore(baseline, attempted)
  })
}
