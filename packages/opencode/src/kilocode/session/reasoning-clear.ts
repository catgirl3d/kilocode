// fork_change - new file
import { createHash } from "node:crypto"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Token } from "@/util/token"
import * as KiloClearScope from "./clear-scope"
import * as KiloReasoningMarker from "./reasoning-marker"

const log = Log.create({ service: "kilocode.session.reasoning-clear" })

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const PreviewResult = Schema.Struct({
  turns: Count,
  parts: Count,
  tokens: Count,
  unsupported: Count,
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
  "KiloReasoningClearStalePreviewError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

type Input = {
  sessionID: SessionID
  keepTurns: number
  sessions: Pick<Session.Interface, "messages" | "updatePart">
}

type Target = {
  turn: MessageID
  part: SessionV1.ReasoningPart
}

function unsupported(part: SessionV1.Part) {
  if (KiloReasoningMarker.unsupported(part)) return true
  if (part.type !== "reasoning" || KiloReasoningMarker.cleared(part)) return false
  return part.text.trim().length === 0 && "metadata" in part && part.metadata != null
}

function eligible(part: SessionV1.Part): part is SessionV1.ReasoningPart {
  if (part.type !== "reasoning" || KiloReasoningMarker.cleared(part)) return false
  return part.time.end != null && part.text.trim().length > 0
}

/** Finished reasoning that replay can omit: no provider state to preserve and not yet cleared. */
export function clearable(part: SessionV1.Part): part is SessionV1.ReasoningPart {
  return !unsupported(part) && eligible(part)
}

/**
 * Mark reasoning cleared in place and persist it. With `reload`, the stored copy is marked instead,
 * for callers whose in-memory parts carry prompt-time transforms.
 */
export const clear = Effect.fn("KiloReasoningClear.clear")(function* (input: {
  part: SessionV1.ReasoningPart
  now: number
  reload: boolean
  sessions: Pick<Session.Interface, "getPart" | "updatePart">
}) {
  input.part.metadata = KiloReasoningMarker.mark(input.part, input.now).metadata
  if (!input.reload) {
    yield* input.sessions.updatePart(input.part)
    return
  }
  const raw = yield* input.sessions.getPart({
    sessionID: input.part.sessionID,
    messageID: input.part.messageID,
    partID: input.part.id,
  })
  if (raw?.type !== "reasoning") return
  yield* input.sessions.updatePart(KiloReasoningMarker.mark(raw, input.now))
})

function stats(targets: Target[]) {
  return {
    parts: targets.length,
    turns: new Set(targets.map((target) => target.turn)).size,
    tokens: targets.reduce((sum, target) => sum + Token.estimate(target.part.text), 0),
  }
}

const plan = Effect.fn("KiloReasoningClear.plan")(function* (input: Input) {
  const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
  const scope = KiloClearScope.old(messages, input.keepTurns)

  const targets: Target[] = []
  let skipped = 0
  for (const { turn, part } of scope.parts) {
    if (unsupported(part)) {
      skipped++
      continue
    }
    if (!eligible(part)) continue
    targets.push({ turn, part })
  }

  // The token pins the exact parts shown in the preview.
  const token = createHash("sha256")
    .update(JSON.stringify(targets.map((target) => [target.part.id, target.part.text])))
    .digest("hex")
  return { messages: messages.length, projected: scope.projected, targets, unsupported: skipped, token }
})

export const preview = Effect.fn("KiloReasoningClear.preview")(function* (input: Input) {
  const value = yield* plan(input)
  const output = { ...stats(value.targets), unsupported: value.unsupported, token: value.token }
  log.debug("manual reasoning clear preview", {
    sessionID: input.sessionID,
    rawMessages: value.messages,
    projectionMessages: value.projected,
    ...output,
  })
  return output satisfies PreviewResult
})

export const apply = Effect.fn("KiloReasoningClear.apply")(function* (input: Input & { token: string }) {
  const value = yield* plan(input)
  if (value.token !== input.token)
    return yield* new StalePreviewError({
      message: "The reasoning-clear preview is stale. Preview again before clearing.",
    })
  const now = Date.now()
  for (const target of value.targets) yield* input.sessions.updatePart(KiloReasoningMarker.mark(target.part, now))
  const output = stats(value.targets)
  log.info("manual reasoning clear applied", { sessionID: input.sessionID, ...output })
  return output satisfies ApplyResult
})
