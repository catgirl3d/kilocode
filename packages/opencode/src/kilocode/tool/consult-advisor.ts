// fork_change - new file
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Provider, parseModel } from "@/provider/provider"
import { SessionRetry } from "@/session/retry"
import { InstanceState } from "@/effect/instance-state"
import { KiloReference } from "@/kilocode/reference/contains"
import * as KiloConfiguredReference from "@/kilocode/reference"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import * as TextStream from "@/kilocode/text-stream"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { hasVariant } from "@/kilocode/provider/provider"
import { KiloLLM } from "@/kilocode/session/llm"
import { KiloErrorPolicy } from "@/kilocode/session/error-policy"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { SessionTranscript } from "@/kilocode/session/transcript"
import { Tool } from "@/tool/tool"
import * as ToolJsonSchema from "@/tool/json-schema"
import * as AdvisorSlots from "@/kilocode/tool/advisor-slots"
import {
  FileRange,
  Params,
  FILE_LIMIT,
  SAMPLE_BYTES,
  acquire,
  release,
  BASE,
  errorOf,
  detail,
  heading,
  plural,
  looksBinary,
  budget,
  collect,
  BUSY_TITLE,
  UNAVAILABLE_TITLE,
  FAILED_TITLE,
  CANCELLED_TITLE,
  PREPARING_TITLE,
  WAITING_TITLE,
  RETRYING_TITLE,
  RETRIES,
  PATIENCE,
  REASONING_TITLE,
  WRITING_TITLE,
  COMPLETED_TITLE,
  brief,
  type AdvisorProgress,
} from "@/kilocode/tool/advisor-core"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Exit, Option, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import path from "node:path"
import DESCRIPTION from "./consult-advisor.txt"

export { acquire, release }

type Resolved =
  | { slot: AdvisorSlots.Slot; reason: string; model?: undefined; variant?: undefined }
  | { slot: AdvisorSlots.Slot; reason?: undefined; model: Provider.Model; variant?: string }

type AdvisorMetadata = { truncated?: boolean; advisors?: AdvisorProgress[]; warnings?: string[] }

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

function reviewer(model: Provider.Model, role?: string): Agent.Info {
  return {
    name: "advisor",
    mode: "primary",
    hidden: true,
    options: {},
    permission: [],
    model: { providerID: model.providerID, modelID: model.id },
    prompt: role ? `${BASE}\n\nYour role:\n${role.trim()}` : `You are an engineering advisor. ${BASE}`,
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

function denied(input: unknown) {
  return (
    input instanceof PermissionV1.RejectedError ||
    input instanceof PermissionV1.CorrectedError ||
    input instanceof PermissionV1.DeniedError
  )
}

async function limited(file: KiloReadObject.File, signal?: AbortSignal) {
  const bytes = await file.read(FILE_LIMIT + 1, signal)
  if (bytes.byteLength > FILE_LIMIT)
    throw new Error(`Cannot read ${file.requested}: non-UTF-8 file exceeds the ${FILE_LIMIT}-byte limit.`)
  return bytes
}

function excerpt(file: KiloReadObject.File, range: FileRange, limit: number, abortSignal: AbortSignal) {
  return Effect.tryPromise({
    try: async (signal) => {
      const combined = AbortSignal.any([abortSignal, signal])
      const sample = await file.sample(SAMPLE_BYTES, combined)
      if (looksBinary(sample)) throw new Error(`Cannot read binary file: ${file.requested}`)
      return TextStream.withFallback(
        () => file.stream(combined),
        (next) => limited(file, next),
        async (stream) => {
          const body = budget(limit)
          const end = await collect(stream, range, body.add, combined, file.requested)
          const attempt = budget(limit)
          attempt.add(`File: ${file.target}\nLines: ${range.start}-${end}\n`)
          if (end < range.end) {
            attempt.add(`Requested lines: ${range.start}-${range.end}\n`)
            attempt.add(`Range warning: end clamped to EOF; file has ${end} lines.\n`)
          }
          attempt.add(body.text())
          return {
            text: attempt.text(),
            warning:
              end < range.end
                ? `${file.target}: requested lines ${range.start}-${range.end}; supplied ${range.start}-${end}; file has ${end} lines (end clamped to EOF).`
                : undefined,
          }
        },
        combined,
      )
    },
    catch: errorOf,
  })
}

function missing(fs: Pick<FSUtil.Interface, "realPath">, requested: string, worktree: string, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const parent = yield* fs.realPath(path.dirname(requested)).pipe(Effect.option)
    if (parent._tag === "None") return yield* Effect.fail(new Error(`File not found: ${requested}`))
    yield* Effect.raceFirst(
      assertExternalDirectoryEffect(ctx, parent.value, { bypass: false, kind: "directory" }),
      abort(ctx),
    )
    yield* Effect.raceFirst(
      ctx.ask({
        permission: "read",
        patterns: [...new Set([requested, parent.value].map((item) => path.relative(worktree, item)))],
        always: ["*"],
        metadata: {},
      }),
      abort(ctx),
    )
    return yield* Effect.fail(new Error(`File not found: ${requested}`))
  })
}

function prepare(params: Params, ctx: Tool.Context, config: Config.Info) {
  const files = params.files ?? []
  if (!params.materials && files.length === 0) {
    return Effect.succeed(undefined as { text: string; warnings: string[] } | undefined)
  }

  return Effect.gen(function* () {
    const out = budget()
    out.add("Supplied materials and file excerpts:")
    if (params.materials) {
      out.add("\n\nMaterials:")
      out.add("\n\n")
      out.add(params.materials)
    }
    if (files.length === 0) return { text: out.text(), warnings: [] }

    const instance = yield* InstanceState.context
    const service = yield* Effect.serviceOption(FSUtil.Service)
    if (Option.isNone(service)) return yield* Effect.fail(new Error("File attachments require filesystem access"))
    const fs = service.value
    const references = KiloConfiguredReference.resolveAll({
      references: config.reference ?? {},
      directory: instance.directory,
      worktree: instance.worktree,
    })
    out.add("\n\nFile excerpts:")
    const warnings: string[] = []
    for (const range of files) {
      let requested = path.resolve(instance.directory, range.path)
      if (process.platform === "win32") requested = FSUtil.normalizePath(requested)
      const info = yield* fs.stat(requested).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )
      if (!info) return yield* missing(fs, requested, instance.worktree, ctx)
      const file = info.type === "Directory" ? undefined : yield* KiloReadObject.file(requested)
      const target = file
        ? file.target
        : yield* fs
            .realPath(requested)
            .pipe(Effect.map((item) => (process.platform === "win32" ? FSUtil.normalizePath(item) : item)))
      const explicit =
        typeof ctx.extra?.["referenceRoot"] === "string" &&
        (yield* KiloReference.path(fs, ctx.extra["referenceRoot"], target))
      const referenced = explicit || (yield* KiloReference.contains({ fs, references, target }))
      yield* Effect.raceFirst(
        assertExternalDirectoryEffect(ctx, target, {
          bypass: referenced,
          kind: file ? "file" : "directory",
        }),
        abort(ctx),
      )
      yield* Effect.raceFirst(
        ctx.ask({
          permission: "read",
          patterns: [...new Set([requested, target].map((item) => path.relative(instance.worktree, item)))],
          always: ["*"],
          metadata: {},
        }),
        abort(ctx),
      )
      if (!file) return yield* Effect.fail(new Error(`Not a regular file: ${requested}`))
      out.add("\n\n")
      const text = yield* KiloReadObject.use(file, (bound) => excerpt(bound, range, out.left(), ctx.abort))
      out.add(text.text)
      if (text.warning) warnings.push(text.warning)
    }
    return { text: out.text(), warnings }
  })
}

export const ConsultAdvisorTool = Tool.define<
  typeof Params,
  AdvisorMetadata,
  Config.Service | Provider.Service | LLM.Service | Session.Service,
  "consult_advisor"
>(
  "consult_advisor",
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const sessions = yield* Session.Service
    const resolve = (slot: AdvisorSlots.Slot): Effect.Effect<Resolved> =>
      Effect.gen(function* () {
        if (slot.prompt && slot.prompt.length > AdvisorSlots.PROMPT_LIMIT) {
          return { slot, reason: `The configured advisor prompt exceeds ${AdvisorSlots.PROMPT_LIMIT} characters.` }
        }
        const parsed = yield* Effect.try({
          try: () => parseModel(slot.model),
          catch: () => new Error("invalid advisor model"),
        }).pipe(Effect.option)
        if (parsed._tag === "None") return { slot, reason: `The configured advisor model is invalid: ${slot.model}.` }
        const model = yield* provider.getModel(parsed.value.providerID, parsed.value.modelID).pipe(Effect.option)
        if (model._tag === "None") {
          return { slot, reason: `The configured advisor model could not be resolved: ${slot.model}.` }
        }
        const variant = resolveVariant(model.value, slot.variant)
        if (variant.available) {
          return {
            slot,
            reason: `The configured advisor variant is unavailable: ${slot.variant}. Available variants: ${variant.available.join(", ") || "none"}.`,
          }
        }
        return { slot, model: model.value, variant: variant.variant }
      })
    return {
      description: DESCRIPTION,
      parameters: Params,
      jsonSchema: ToolJsonSchema.fromSchema(
        Schema.Struct({
          ...Params.fields,
          advisors: Schema.optional(Schema.Array(Schema.String).check(Schema.isLengthBetween(1, 3))),
        }),
      ),
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
            const progress: AdvisorProgress[] = []
            const warnings: string[] = []
            const gate = Semaphore.makeUnsafe(1)
            const snapshot = () => progress.map((item) => ({ ...item }))
            const meta = (truncated?: boolean): AdvisorMetadata => ({
              ...(truncated === undefined ? {} : { truncated }),
              advisors: snapshot(),
              warnings: warnings.length ? warnings : undefined,
            })
            const publish = (title?: string | (() => string)) =>
              gate.withPermit(
                Effect.suspend(() => {
                  if (title !== undefined) phase.title = typeof title === "function" ? title() : title
                  return ctx.metadata({ title: phase.title, metadata: meta() })
                }),
              )
            const setTitle = (title: string) => {
              if (phase.title === title) return Effect.void
              return publish(title)
            }
            const mutate = (name: string, change: Partial<AdvisorProgress>) => {
              const item = progress.find((entry) => entry.name === name)
              if (!item) return false
              if (
                (change.status === undefined || change.status === item.status) &&
                (change.text === undefined || change.text === item.text) &&
                (change.error === undefined || change.error === item.error)
              ) {
                return false
              }
              Object.assign(item, change)
              return true
            }
            const update = (name: string, change: Partial<AdvisorProgress>, title?: string) => {
              if (!mutate(name, change) && (title === undefined || title === phase.title)) return Effect.void
              return publish(title)
            }
            yield* setTitle(PREPARING_TITLE)

            const config = yield* cfg.get()
            const slots = AdvisorSlots.resolve(config.experimental)
            if (slots.length === 0) {
              return {
                title: UNAVAILABLE_TITLE,
                output: "No advisor model is configured. Set experimental.advisor_model and retry.",
                metadata: {},
              }
            }
            const selection = AdvisorSlots.select(slots, params.advisors)
            if ("unknown" in selection) {
              return {
                title: UNAVAILABLE_TITLE,
                output: `Unknown advisor: ${selection.unknown}. Available advisors: ${slots.map((slot) => slot.name).join(", ")}.`,
                metadata: {},
              }
            }
            const resolved = yield* Effect.forEach(selection.slots, resolve)
            const single = resolved.length === 1
            const first = resolved.at(0)
            for (const item of resolved) {
              progress.push({
                name: item.slot.name,
                model: item.slot.model,
                variant: item.slot.variant,
                status: item.model ? "waiting" : "unavailable",
                reason: item.reason,
              })
            }
            if (single && first?.reason) {
              yield* publish(UNAVAILABLE_TITLE)
              return { title: UNAVAILABLE_TITLE, output: first.reason, metadata: meta() }
            }
            if (resolved.every((item) => item.reason)) {
              yield* publish(UNAVAILABLE_TITLE)
              return {
                title: UNAVAILABLE_TITLE,
                output: resolved.map((item) => `${heading(item.slot)}\n\nUnavailable: ${item.reason}`).join("\n\n"),
                metadata: meta(),
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
            const prepared = yield* Effect.raceFirst(prepare(params, ctx, config), abort(ctx)).pipe(Effect.exit)
            if (ctx.abort.aborted || (Exit.isFailure(prepared) && Cause.hasInterruptsOnly(prepared.cause))) {
              yield* setTitle(CANCELLED_TITLE)
              return yield* Effect.interrupt
            }
            if (Exit.isFailure(prepared)) {
              const err = Cause.squash(prepared.cause)
              if (denied(err)) return yield* Effect.die(err)
              yield* setTitle(FAILED_TITLE)
              return {
                title: FAILED_TITLE,
                output: `Advisor context preparation failed: ${detail(err)}`,
                metadata: {},
              }
            }
            const supplied = prepared.value
            warnings.push(...(supplied?.warnings ?? []))
            const notice = supplied?.warnings.length
              ? `Context warnings:\n${supplied.warnings.map((item) => `- ${item}`).join("\n")}`
              : undefined
            const body = brief({
              focus,
              question,
              proposal: params.proposal,
              transcript,
              current: currentText,
              supplied: supplied?.text,
            })
            // Each slot gets a fresh stream per attempt and its own retry policy state.
            const consult = (
              input: { slot: AdvisorSlots.Slot; model: Provider.Model; variant?: string },
              id: SessionID,
              onPhase: (kind: "reasoning" | "writing") => Effect.Effect<void>,
              onRetry: () => Effect.Effect<void>,
            ) =>
              Effect.retry(
                Effect.suspend(() =>
                  KiloLLM.text(
                    llm
                      .stream({
                        agent: reviewer(input.model, input.slot.prompt),
                        user: user(id, input.model, input.variant),
                        sessionID: id,
                        parentSessionID: ctx.sessionID,
                        model: input.model,
                        system: [],
                        messages: [{ role: "user", content: body }],
                        tools: {},
                        toolChoice: "none",
                      })
                      .pipe(
                        Stream.tap((event) => {
                          if (event.type === "reasoning-start" || event.type === "reasoning-delta") {
                            return onPhase("reasoning")
                          }
                          if (event.type === "text-start" || event.type === "text-delta") {
                            return onPhase("writing")
                          }
                          return Effect.void
                        }),
                      ),
                  ),
                ),
                SessionRetry.policy({
                  provider: input.model.providerID,
                  parse: (error) => {
                    const parsed = KiloSessionProcessor.parseError(error, {
                      providerID: input.model.providerID,
                      aborted: ctx.abort.aborted,
                    })
                    // A provider hint to wait longer than PATIENCE ends the retries, so the failure reaches the agent now.
                    const wait = SessionV1.APIError.isInstance(parsed) ? SessionRetry.delay(1, parsed) : 0
                    return wait > PATIENCE ? KiloErrorPolicy.blockRetry(parsed) : parsed
                  },
                  limit: RETRIES,
                  set: onRetry,
                }),
              )

            if (single && first?.model) {
              yield* publish(WAITING_TITLE)
              const exit = yield* Effect.raceFirst(
                consult(
                  { slot: first.slot, model: first.model, variant: first.variant },
                  SessionID.make(`${ctx.sessionID}-advisor`),
                  (kind) =>
                    update(first.slot.name, { status: kind }, kind === "reasoning" ? REASONING_TITLE : WRITING_TITLE),
                  () => update(first.slot.name, { status: "retrying" }, RETRYING_TITLE),
                ),
                abort(ctx),
              ).pipe(Effect.exit)
              if (ctx.abort.aborted) {
                yield* setTitle(CANCELLED_TITLE)
                return yield* Effect.interrupt
              }
              if (Exit.isFailure(exit)) {
                const failure = `Advisor consultation failed: ${detail(Cause.squash(exit.cause))}`
                yield* update(first.slot.name, { status: "failed", error: failure }, FAILED_TITLE)
                return {
                  title: FAILED_TITLE,
                  output: notice ? `${notice}\n\n${failure}` : failure,
                  metadata: meta(),
                }
              }
              const output = exit.value.trim() || "The advisor returned no guidance."
              yield* update(first.slot.name, { status: "done", text: output }, COMPLETED_TITLE)
              return {
                title: COMPLETED_TITLE,
                output: notice ? `${notice}\n\n${output}` : output,
                metadata: meta(false),
              }
            }

            const total = resolved.filter((item) => item.model).length
            const done = { count: 0 }
            yield* publish(`Consulting ${total} ${plural(total)}`)
            const runs = yield* Effect.raceFirst(
              Effect.forEach(
                resolved,
                (item): Effect.Effect<{ ok: boolean; text: string }> => {
                  if (!item.model) {
                    return Effect.succeed({ ok: false, text: `${heading(item.slot)}\n\nUnavailable: ${item.reason}` })
                  }
                  return consult(
                    { slot: item.slot, model: item.model, variant: item.variant },
                    SessionID.make(`${ctx.sessionID}-advisor-${item.slot.name}`),
                    (kind) => update(item.slot.name, { status: kind }),
                    () => update(item.slot.name, { status: "retrying" }),
                  ).pipe(
                    Effect.exit,
                    Effect.flatMap((exit) => {
                      done.count++
                      const failure = Exit.isFailure(exit)
                        ? detail(Cause.squash(exit.cause)) || "unknown error"
                        : undefined
                      const text = Exit.isSuccess(exit)
                        ? exit.value.trim() || "The advisor returned no guidance."
                        : `Failed: ${failure}`
                      mutate(
                        item.slot.name,
                        failure === undefined ? { status: "done", text } : { status: "failed", error: failure },
                      )
                      return publish(() => `${done.count} of ${total} ${plural(total)} responded`).pipe(
                        Effect.as({ ok: Exit.isSuccess(exit), text: `${heading(item.slot)}\n\n${text}` }),
                      )
                    }),
                  )
                },
                { concurrency: "unbounded" },
              ),
              abort(ctx),
            ).pipe(Effect.exit)
            if (ctx.abort.aborted) {
              yield* setTitle(CANCELLED_TITLE)
              return yield* Effect.interrupt
            }
            if (Exit.isFailure(runs)) {
              const failure = `Advisor consultation failed: ${detail(Cause.squash(runs.cause))}`
              for (const item of progress) {
                if (item.status === "done" || item.status === "failed" || item.status === "unavailable") continue
                Object.assign(item, { status: "failed", error: failure })
              }
              yield* publish(FAILED_TITLE)
              return {
                title: FAILED_TITLE,
                output: notice ? `${notice}\n\n${failure}` : failure,
                metadata: meta(),
              }
            }
            const ok = runs.value.some((item) => item.ok)
            const title = ok ? COMPLETED_TITLE : FAILED_TITLE
            yield* publish(title)
            const output = runs.value.map((item) => item.text).join("\n\n")
            return {
              title,
              output: notice ? `${notice}\n\n${output}` : output,
              metadata: ok ? meta(false) : meta(),
            }
          }).pipe(Effect.ensuring(Effect.sync(() => release(ctx.sessionID))))
        }),
    }
  }),
)
