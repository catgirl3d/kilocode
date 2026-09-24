import type { ModelMessage } from "ai"
import { Cause, Effect, Scope } from "effect" // fork_change
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { KiloSessionMessageOrder } from "@/kilocode/session/message-order"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"

/** Max title-generation attempts per session before the placeholder stays. */
const MAX_ATTEMPTS = 4
/** Max real user messages included in the title context. */
const LIMIT = 4
/** Max characters per included user message. */
const CHARS = 1_000
/** Max characters per included tool result excerpt. */
const TOOL_CHARS = 500
/** Max tool result excerpts included in the title context. */
const TOOL_LIMIT = 2
/** Cap on tracked sessions. Oldest entries are dropped first. */
const MAX_TRACKED = 2_048

const attempts = new Map<string, number>()
const inFlight = new Set<string>() // fork_change

// fork_change start - keep title failure logs actionable without logging error messages
function details(cause: Cause.Cause<unknown>) {
  const err = Cause.squash(cause)
  const field = (key: string) => {
    if (err === null || typeof err !== "object") return undefined
    return Object.getOwnPropertyDescriptor(err, key)?.value
  }
  const type = err instanceof Error ? err.constructor.name : typeof err
  const status = field("statusCode") ?? field("status")
  const code = field("code")
  return {
    errorType: /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(type) ? type : "Error",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { statusCode: status }
      : {}),
    ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
  }
}
// fork_change end

function prune() {
  if (attempts.size <= MAX_TRACKED) return
  for (const key of attempts.keys()) {
    if (attempts.size <= MAX_TRACKED) break
    attempts.delete(key)
  }
}

/** A user message counts as real when at least one part is not synthetic. */
function real(msg: MessageV2.WithParts) {
  if (msg.info.role !== "user") return false
  return msg.parts.some((part) => !("synthetic" in part && part.synthetic))
}

/** Visible user text plus subtask prompts. Synthetic and ignored parts are dropped. */
function text(msg: MessageV2.WithParts) {
  return msg.parts
    .flatMap((part) => {
      if (part.type === "text") return part.synthetic || part.ignored ? [] : [part.text]
      if (part.type === "subtask") return [part.prompt]
      return []
    })
    .join("\n")
    .trim()
}

/** Bounded excerpts of completed tool results from the current turn. */
function tools(turn: MessageV2.WithParts[]) {
  const lines: string[] = []
  for (const msg of turn) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      if (lines.length >= TOOL_LIMIT) return lines
      const output = part.state.output.slice(0, TOOL_CHARS).trim()
      lines.push(`- ${part.tool}: ${part.state.title}${output ? `\n${output}` : ""}`)
    }
  }
  return lines
}

/** Title generation callback owned by the shared prompt loop. */
type Generate = (input: {
  session: Session.Info
  history: MessageV2.WithParts[]
  providerID: MessageV2.User["model"]["providerID"]
  modelID: MessageV2.User["model"]["modelID"]
}) => Effect.Effect<unknown, unknown>

export namespace KiloSessionTitle {
  /** Drop the attempt counter for one session. */
  export function clear(sessionID: string) {
    attempts.delete(sessionID)
  }

  /** Drop every attempt counter (tests). */
  export function clearAll() {
    attempts.clear()
  }

  // fork_change start - allow the first real prompt while retaining the retry cap
  /** Consume one title-generation attempt when history contains a real user turn. */
  export function shouldGenerate(input: { sessionID: string; history: MessageV2.WithParts[] }) {
    const used = attempts.get(input.sessionID) ?? 0
    if (used >= MAX_ATTEMPTS) return false

    const users = input.history.filter(real)
    if (!users.at(-1)) return false

    attempts.set(input.sessionID, used + 1)
    prune()
    return true
  }
  // fork_change end

  /**
   * Build the model request for the title agent. Returns null when the history
   * has no real user turn. The context holds the recent user messages plus a
   * bounded excerpt of the current turn's tool results, so a bare URL or
   * attachment prompt resolves after the agent inspects it.
   */
  export function build(history: MessageV2.WithParts[]): {
    user: MessageV2.User
    messages: ModelMessage[]
  } | null {
    const users = history.filter(real)
    const lastUser = users.at(-1)
    if (!lastUser || lastUser.info.role !== "user") return null

    const index = history.findIndex((msg) => msg.info.id === lastUser.info.id)
    const body = ["User messages, oldest to newest:"]
    users.slice(-LIMIT).forEach((msg, position) => {
      body.push(`${position + 1}. ${text(msg).slice(0, CHARS)}`)
    })
    const excerpts = tools(history.slice(index + 1))
    if (excerpts.length > 0) body.push("", "Work done so far:", ...excerpts)

    return {
      user: lastUser.info,
      messages: [
        {
          role: "user",
          content: [
            "Generate a title for this conversation:",
            "",
            "Title the task, not the reference. When the context is only a link, an issue or ticket number, or a filename, describe the work in general terms instead of restating the reference. Use issue numbers, URLs, or tracker IDs only when the task is specifically about them.",
            "",
            ...body,
          ].join("\n"),
        },
      ],
    }
  }

  // fork_change start - run the first-step title job in service scope, once per session
  /** Load title context and fork generation without tying it to the prompt fiber. */
  export function deferred(input: {
    sessionID: SessionID
    scope: Scope.Scope
    sessions: Session.Interface
    database: Database.Interface
    generate: Generate
  }) {
    return Effect.gen(function* () {
      if (inFlight.has(input.sessionID)) return
      inFlight.add(input.sessionID)
      let forked = false
      yield* Effect.gen(function* () {
        const titled = yield* input.sessions.get(input.sessionID).pipe(Effect.orDie)
        if (titled.parentID || !Session.isDefaultTitle(titled.title)) return

        const history = KiloSessionPrompt.trimBeforeLastSummary(
          KiloSessionPromptQueue.scope(
            input.sessionID,
            yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
              Effect.provideService(Database.Service, input.database),
            ),
          ),
        )
        const finalUser = KiloSessionMessageOrder.latest(history).user
        if (!finalUser || !shouldGenerate({ sessionID: input.sessionID, history })) return

        yield* input
          .generate({
            session: titled,
            history,
            providerID: finalUser.model.providerID,
            modelID: finalUser.model.modelID,
          })
          .pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              return Effect.logError("failed to generate title", { sessionID: input.sessionID, ...details(cause) })
            }),
            Effect.ensuring(Effect.sync(() => inFlight.delete(input.sessionID))),
            Effect.forkIn(input.scope),
          )
        forked = true
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!forked) inFlight.delete(input.sessionID)
          }),
        ),
      )
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return Effect.logError("failed to schedule title generation", { sessionID: input.sessionID, ...details(cause) })
      }),
    )
  }
  // fork_change end
}
