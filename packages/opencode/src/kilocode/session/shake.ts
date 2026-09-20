// fork_change - new file
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { KiloSessionPrompt } from "./prompt"
import { Token } from "@/util/token"

const PROTECTED_TOOLS = new Set(["skill"])
const TAIL = 7
const log = Log.create({ service: "kilocode.session.shake" })
type CompletedPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

export const Result = Schema.Struct({
  parts: Schema.Number,
  tokens: Schema.Number,
  diagnostics: Schema.optional(
    Schema.Struct({
      rawMessages: Schema.Number,
      projectionMessages: Schema.Number,
      tools: Schema.Number,
      completed: Schema.Number,
      protected: Schema.Number,
      compacted: Schema.Number,
      candidates: Schema.Number,
    }),
  ),
})

export type Result = typeof Result.Type

/** Clear eligible tool output outside the recent tail without creating a summary turn. */
export const run = Effect.fn("KiloSessionShake.run")(function* (input: {
  sessionID: SessionID
  sessions: Session.Interface
}) {
  const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
  const projected = KiloSessionPrompt.trimBeforeLastSummary(MessageV2.filterCompacted([...messages].reverse()))
  const candidates: CompletedPart[] = []

  let tools = 0
  let completed = 0
  let protectedCount = 0
  let compacted = 0
  for (let messageIndex = projected.length - 1; messageIndex >= 0; messageIndex--) {
    const message = projected[messageIndex]

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]
      if (part.type !== "tool") continue
      tools++
      if (part.state.status !== "completed") continue
      const done = part as CompletedPart
      completed++
      if (PROTECTED_TOOLS.has(part.tool)) {
        protectedCount++
        continue
      }
      if (part.state.time.compacted !== undefined) {
        compacted++
        continue
      }

      candidates.push(done)
    }
  }

  const targets = candidates.slice(TAIL)
  const tokens = targets.reduce((sum, part) => sum + Token.estimate(part.state.output), 0)
  const diagnostics = {
    rawMessages: messages.length,
    projectionMessages: projected.length,
    tools,
    completed,
    protected: protectedCount,
    compacted,
    candidates: candidates.length,
  }
  log.info("manual shake projection", { sessionID: input.sessionID, ...diagnostics, estimatedTokens: tokens })
  const result = {
    parts: targets.length,
    tokens,
    diagnostics,
  }

  if (targets.length === 0) return result satisfies Result

  for (const part of targets) {
    const raw = yield* input.sessions.getPart({
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
    })
    if (!raw || raw.type !== "tool" || raw.state.status !== "completed") continue
    raw.state.time.compacted = Date.now()
    yield* input.sessions.updatePart(raw)
  }

  return result satisfies Result
})
