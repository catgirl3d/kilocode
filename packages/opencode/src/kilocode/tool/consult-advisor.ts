// fork_change - new file
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Provider, parseModel } from "@/provider/provider"
import { hasVariant } from "@/kilocode/provider/provider"
import { KiloLLM } from "@/kilocode/session/llm"
import { SessionTranscript } from "@/kilocode/session/transcript"
import { Tool } from "@/tool/tool"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Stream from "effect/Stream"
import DESCRIPTION from "./consult-advisor.txt"

const Params = Schema.Struct({
  focus: Schema.optional(Schema.Literals(["plan", "risk", "stuck", "verification", "general"])),
  question: Schema.optional(Schema.Trim.check(Schema.isMaxLength(5_000))),
  proposal: Schema.optional(Schema.String.check(Schema.isMaxLength(64_000))),
})

type Params = Schema.Schema.Type<typeof Params>

const busy = new Set<string>()

export function acquire(sessionID: string) {
  if (busy.has(sessionID)) return false
  busy.add(sessionID)
  return true
}

export function release(sessionID: string) {
  busy.delete(sessionID)
}

function abort(ctx: Tool.Context) {
  return Effect.callback<never, Error>((resume) => {
    const err = () => new DOMException("Aborted", "AbortError")
    if (ctx.abort.aborted) return resume(Effect.fail(err()))
    const stop = () => {
      ctx.abort.removeEventListener("abort", stop)
      resume(Effect.fail(err()))
    }
    ctx.abort.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => ctx.abort.removeEventListener("abort", stop))
  })
}

function reviewer(model: Provider.Model): Agent.Info {
  return {
    name: "advisor",
    mode: "primary",
    hidden: true,
    options: {},
    permission: [],
    model: { providerID: model.providerID, modelID: model.id },
    prompt:
      "You are an engineering advisor. Do not use tools. Do not claim to have inspected files. Give actionable guidance based only on the supplied transcript.",
  }
}

function user(sessionID: SessionID, model: Provider.Model, variant?: string): SessionV1.User {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "advisor",
    model: { providerID: model.providerID, modelID: model.id, variant },
  }
}

function resolveVariant(model: Provider.Model, configured?: string) {
  if (!configured) return { variant: undefined, available: undefined }
  if (hasVariant(model, configured)) return { variant: configured, available: undefined }
  return { variant: undefined, available: Object.keys(model.variants ?? {}) }
}

function clip(text: string) {
  if (text.length <= 64_000) return text
  return `${text.slice(0, 64_000)}\n(truncated)`
}

const BUSY_TITLE = "Advisor busy"
const UNAVAILABLE_TITLE = "Advisor unavailable"
const FAILED_TITLE = "Advisor failed"
const PREPARING_TITLE = "Preparing advisor context"
const WAITING_TITLE = "Waiting for first response"
const REASONING_TITLE = "Advisor is reasoning"
const WRITING_TITLE = "Advisor is writing"
const COMPLETED_TITLE = "Advisor completed"

export const ConsultAdvisorTool = Tool.define<
  typeof Params,
  { truncated?: boolean },
  Config.Service | Provider.Service | LLM.Service | Session.Service,
  "consult_advisor"
>(
  "consult_advisor",
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!acquire(ctx.sessionID)) {
            return {
              title: BUSY_TITLE,
              output: "An advisor consultation is already running for this session.",
              metadata: {},
            }
          }
          return yield* Effect.gen(function* () {
            const phase = { title: undefined as string | undefined }
            const setTitle = (title: string) => {
              if (phase.title === title) return Effect.void
              phase.title = title
              return ctx.metadata({ title })
            }
            yield* setTitle(PREPARING_TITLE)

            const configured = (yield* cfg.get()).experimental?.advisor_model
            if (!configured) {
              return {
                title: UNAVAILABLE_TITLE,
                output: "No advisor model is configured. Set experimental.advisor_model and retry.",
                metadata: {},
              }
            }

            const parsed = yield* Effect.try({
              try: () => parseModel(configured),
              catch: () => new Error("invalid advisor model"),
            }).pipe(Effect.option)
            if (parsed._tag === "None") {
              return {
                title: UNAVAILABLE_TITLE,
                output: `The configured advisor model is invalid: ${configured}.`,
                metadata: {},
              }
            }
            const model = yield* provider.getModel(parsed.value.providerID, parsed.value.modelID).pipe(Effect.option)
            if (model._tag === "None") {
              return {
                title: UNAVAILABLE_TITLE,
                output: `The configured advisor model could not be resolved: ${configured}.`,
                metadata: {},
              }
            }
            const configuredVariant = (yield* cfg.get()).experimental?.advisor_variant
            const variant = resolveVariant(model.value, configuredVariant)
            if (variant.available) {
              return {
                title: UNAVAILABLE_TITLE,
                output: `The configured advisor variant is unavailable: ${configuredVariant}. Available variants: ${variant.available.join(", ") || "none"}.`,
                metadata: {},
              }
            }

            const focus = params.focus ?? "general"
            const question = params.question?.trim() || "Provide the most useful next-step guidance."
            const session = yield* sessions
              .get(ctx.sessionID)
              .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
            if (!session) {
              return {
                title: UNAVAILABLE_TITLE,
                output: "The current session could not be found. Retry the consultation.",
                metadata: {},
              }
            }
            const transcript = ctx.messages.length
              ? SessionTranscript.format(session, ctx.messages, { max: 100_000 })
              : "[no prior context]"
            const current = ctx.extra?.currentAssistant
            const parts = current
              ? (current.parts ??
                (yield* sessions
                  .messages({ sessionID: ctx.sessionID })
                  .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([])))).find(
                  (item) => item.info.id === current.id,
                )?.parts ??
                [])
              : []
            const currentText = parts
              .filter((part): part is SessionV1.TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n\n")
            const body = [
              `Focus: ${focus}`,
              `Question: ${question}`,
              ...(params.proposal ? ["Proposal:", clip(params.proposal)] : []),
              "Recent conversation transcript:",
              transcript,
              ...(currentText ? ["Current assistant message (in progress):", clip(currentText)] : []),
            ].join("\n\n")
            yield* setTitle(WAITING_TITLE)
            const stream = KiloLLM.text(
              llm
                .stream({
                  agent: reviewer(model.value),
                  user: user(SessionID.make(`${ctx.sessionID}-advisor`), model.value, variant.variant),
                  sessionID: SessionID.make(`${ctx.sessionID}-advisor`),
                  parentSessionID: ctx.sessionID,
                  model: model.value,
                  system: [],
                  messages: [{ role: "user", content: body }],
                  tools: {},
                  toolChoice: "none",
                })
                .pipe(
                  Stream.tap((event) => {
                    if (event.type === "reasoning-start" || event.type === "reasoning-delta") {
                      return setTitle(REASONING_TITLE)
                    }
                    if (event.type === "text-start" || event.type === "text-delta") {
                      return setTitle(WRITING_TITLE)
                    }
                    return Effect.void
                  }),
                ),
            )
            const exit = yield* Effect.raceFirst(stream, abort(ctx)).pipe(Effect.exit)
            if (ctx.abort.aborted) return yield* Effect.interrupt
            if (Exit.isFailure(exit)) {
              yield* setTitle(FAILED_TITLE)
              const err = Cause.squash(exit.cause)
              const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500)
              return {
                title: FAILED_TITLE,
                output: `Advisor consultation failed: ${detail}`,
                metadata: {},
              }
            }
            const output = exit.value.trim()
            yield* setTitle(COMPLETED_TITLE)
            return {
              title: COMPLETED_TITLE,
              output: output || "The advisor returned no guidance.",
              metadata: { truncated: false },
            }
          }).pipe(Effect.ensuring(Effect.sync(() => release(ctx.sessionID))))
        }),
    }
  }),
)
