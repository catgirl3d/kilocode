// fork_change - new file
import { createHash } from "node:crypto"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Token } from "@/util/token"
import * as KiloClearScope from "./clear-scope"
import { PROTECTED_TOOLS } from "./shake"

const log = Log.create({ service: "kilocode.session.tool-clear" })

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const PreviewResult = Schema.Struct({
  turns: Count,
  parts: Count,
  tokens: Count,
  token: Schema.String,
})

export type PreviewResult = typeof PreviewResult.Type

export const ApplyResult = Schema.Struct({
  parts: Count,
  turns: Count,
  tokens: Count,
})

export type ApplyResult = typeof ApplyResult.Type

export class StalePreviewError extends Schema.TaggedErrorClass<StalePreviewError>()(
  "KiloToolClearStalePreviewError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

type Input = {
  sessionID: SessionID
  keepTurns: number
  sessions: Pick<Session.Interface, "messages" | "getPart" | "updatePart">
}

type Done = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

type Target = {
  turn: MessageID
  part: Done
}

/** Finished tool output that replay can still send and that no protection applies to. */
export function clearable(part: SessionV1.Part): part is Done {
  if (part.type !== "tool" || part.state.status !== "completed") return false
  if (PROTECTED_TOOLS.has(part.tool)) return false
  return part.state.time.compacted === undefined
}

function stats(targets: Target[]) {
  return {
    parts: targets.length,
    turns: new Set(targets.map((target) => target.turn)).size,
    tokens: targets.reduce((sum, target) => sum + Token.estimate(target.part.state.output), 0),
  }
}

const plan = Effect.fn("KiloToolClear.plan")(function* (input: Input) {
  const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
  const scope = KiloClearScope.old(messages, input.keepTurns)
  const targets: Target[] = []
  for (const { turn, part } of scope.parts) if (clearable(part)) targets.push({ turn, part })

  // The token pins the exact outputs shown in the preview.
  const token = createHash("sha256")
    .update(JSON.stringify(targets.map((target) => [target.part.id, target.part.state.output])))
    .digest("hex")
  return { messages: messages.length, projected: scope.projected, targets, token }
})

export const preview = Effect.fn("KiloToolClear.preview")(function* (input: Input) {
  const value = yield* plan(input)
  const output = { ...stats(value.targets), token: value.token }
  log.debug("manual tool clear preview", {
    sessionID: input.sessionID,
    rawMessages: value.messages,
    projectionMessages: value.projected,
    ...output,
  })
  return output satisfies PreviewResult
})

export const apply = Effect.fn("KiloToolClear.apply")(function* (input: Input & { token: string }) {
  const value = yield* plan(input)
  if (value.token !== input.token)
    return yield* new StalePreviewError({
      message: "The tool-clear preview is stale. Preview again before clearing.",
    })
  const now = Date.now()
  const done: Target[] = []
  for (const target of value.targets) {
    // Projected parts have their metadata stripped, so mark the stored copy instead.
    const raw = yield* input.sessions.getPart({
      sessionID: target.part.sessionID,
      messageID: target.part.messageID,
      partID: target.part.id,
    })
    if (raw?.type !== "tool" || raw.state.status !== "completed") continue
    raw.state.time.compacted = now
    yield* input.sessions.updatePart(raw)
    done.push(target)
  }
  // Report only what was actually cleared: a part removed since the plan is not counted.
  const output = stats(done)
  log.info("manual tool clear applied", { sessionID: input.sessionID, ...output })
  return output satisfies ApplyResult
})
