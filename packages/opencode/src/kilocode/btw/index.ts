// fork_change - new file
import { Cause, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { Usage, type ProviderMetadata } from "@opencode-ai/llm"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { randomUUID } from "node:crypto"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { InstanceContext } from "@/kilocode/instance"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { KiloSessionMessageOrder } from "@/kilocode/session/message-order"
import { SessionTranscript } from "@/kilocode/session/transcript"
import { BtwCapture } from "./capture"
import { BtwContext } from "./context"
import { BtwStore } from "./store"
import type { BtwItem, BtwStatus } from "./schema"

const TICK = 120
const MAX = 200_000
const NO_ANSWER = "The model returned no answer."
const TOOL_ANSWER = "The model returned no answer (it tried to call a tool)."

const SYSTEM = "You answer quick side questions about an ongoing coding session. Do not use tools."

type Run = { id: string; fiber?: Fiber.Fiber<void, unknown> }

type StartInput = {
  sessionID: SessionID
  question: string
  threadID?: string
  scope: Scope.Scope
}

// One active run per session. Claimed synchronously in `start` so two starts cannot both pass the check.
const active = new Map<string, Run>()

const claim = (sessionID: string) => {
  if (active.has(sessionID)) return undefined
  const entry: Run = { id: `btw_${randomUUID()}` }
  active.set(sessionID, entry)
  return entry
}

const release = (sessionID: string, entry: Run) => {
  if (active.get(sessionID) === entry) active.delete(sessionID)
}

const live = (id: string) => [...active.values()].some((run) => run.id === id)

const publish = (ctx: InstanceContext, sessionID: SessionID, item: BtwItem) =>
  Effect.promise(() => Bus.publish(ctx, KiloSessionEvent.BtwUpdated, { sessionID, item }))

// Warm path: the captured request as is, with a fresh user id and no forced tool choice.
const warm = Effect.fn("KiloBtw.warm")(function* (
  frame: BtwCapture.Frame,
  msgs: MessageV2.WithParts[],
  prior: BtwItem[],
  question: string,
) {
  const newer = yield* MessageV2.toModelMessagesEffect(BtwContext.newer(msgs, frame.assistant), frame.input.model)
  return {
    ...frame.input,
    user: { ...frame.input.user, id: MessageID.ascending() },
    toolChoice: undefined,
    messages: [
      ...BtwCapture.copy(frame.input.messages),
      ...newer,
      ...BtwContext.thread(prior),
      { role: "user" as const, content: BtwContext.prompt(question) },
    ],
  }
})

// Cold path: no usable captured frame, so the history goes in as text with no tools.
const cold = Effect.fn("KiloBtw.cold")(function* (
  sessionID: SessionID,
  session: Session.Info,
  msgs: MessageV2.WithParts[],
  prior: BtwItem[],
  question: string,
) {
  const provider = yield* Provider.Service
  const user = KiloSessionMessageOrder.latest(msgs).user
  if (!user) return yield* new KiloBtw.Empty({ message: "Send a message first, then ask a side question." })
  const model = yield* provider.getModel(user.model.providerID, user.model.modelID)
  const agent: Agent.Info = { name: "btw", mode: "primary", permission: [], options: {}, prompt: SYSTEM }
  return {
    agent,
    user: {
      id: MessageID.ascending(),
      sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: "btw",
      model: { providerID: model.providerID, modelID: model.id, variant: user.model.variant },
    },
    sessionID,
    parentSessionID: session.parentID,
    model,
    system: [],
    tools: {},
    toolChoice: "none" as const,
    messages: [
      { role: "user" as const, content: SessionTranscript.format(session, msgs, { max: MAX }) },
      ...BtwContext.thread(prior),
      { role: "user" as const, content: BtwContext.prompt(question) },
    ],
  }
})

// Maps the run's exit and streamed text to a terminal status. A failure is an error, an interrupt is a cancel.
function outcome(exit: Exit.Exit<void, unknown>, text: string, tool: boolean): { status: BtwStatus; error?: string } {
  if (!Exit.isFailure(exit)) {
    if (text.trim()) return { status: "done" }
    return { status: "error", error: tool ? TOOL_ANSWER : NO_ANSWER }
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return { status: "cancelled" }
  // An Error reports its own message; Cause.pretty would prefix it with "Error: ".
  const failure = Cause.squash(exit.cause)
  const message = failure instanceof Error ? failure.message : Cause.pretty(exit.cause)
  return { status: "error", error: message.split("\n").at(0)?.trim() || "The side question failed." }
}

const launch = Effect.fn("KiloBtw.launch")(function* (input: StartInput, entry: Run) {
  const ctx = yield* InstanceState.context
  const llm = yield* LLM.Service
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service
  const session = yield* sessions.get(input.sessionID)
  const loaded = yield* MessageV2.filterCompactedEffect(input.sessionID)
  const trimmed = KiloSessionPrompt.trimBeforeLastSummary(KiloSessionPromptQueue.scope(input.sessionID, loaded))
  // A pending revert keeps its messages in the DB until the next prompt, whose cleanup removes them. /btw must not see them.
  const visible = session.revert ? BtwContext.cut(trimmed, session.revert) : trimmed
  const msgs = BtwContext.settled(visible)
  const prior = input.threadID ? yield* BtwStore.thread(input.sessionID, input.threadID) : []
  if (input.threadID && prior.length === 0)
    return yield* new KiloBtw.Thread({ message: "Unknown side-question thread." })

  // The warm check reads the unsettled list: the captured assistant is usually still streaming, and settling drops it.
  // A pending revert always goes cold, because the captured frame was built before the revert.
  const frame = BtwCapture.get(input.sessionID)
  const request: LLM.StreamInput =
    !session.revert && BtwContext.warm(frame, visible)
      ? yield* warm(frame, msgs, prior, input.question)
      : yield* cold(input.sessionID, session, msgs, prior, input.question)

  // llm.ts rewrites the session fields of the one cached workflow language object, so a side question cannot share it.
  // Checked before any row is written. A language that cannot be resolved is left to the run, which reports it on the item.
  const language = yield* provider.getLanguage(request.model).pipe(Effect.exit)
  if (Exit.isSuccess(language) && language.value instanceof GitLabWorkflowLanguageModel)
    return yield* new KiloBtw.Unsupported({
      message: "Side questions are not available for GitLab Duo workflow models.",
    })

  const item: BtwItem = {
    id: entry.id,
    sessionID: input.sessionID,
    threadID: input.threadID || entry.id,
    status: "running",
    question: input.question,
    answer: "",
    providerID: request.model.providerID,
    modelID: request.model.id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }
  yield* BtwStore.insert(item)
  yield* publish(ctx, input.sessionID, item)

  const state = {
    text: "",
    last: 0,
    tool: false,
    usage: undefined as Usage | undefined,
    metadata: undefined as ProviderMetadata | undefined,
  }
  const run = llm.stream(request).pipe(
    Stream.tap((event) => {
      if (event.type === "text-delta") {
        state.text += event.text
        if (Date.now() - state.last < TICK) return Effect.void
        state.last = Date.now()
        return publish(ctx, input.sessionID, { ...item, answer: state.text })
      }
      if (event.type === "tool-input-start" || event.type === "tool-call") {
        state.tool = true
        return Effect.void
      }
      // Like SessionProcessor, a provider error ends the turn. Failing the stream ends the item as an error.
      if (event.type === "provider-error") return Effect.fail(new Error(event.message))
      if (event.type === "step-finish" || event.type === "finish") {
        if (event.usage) {
          state.usage = event.usage
          state.metadata = event.providerMetadata
        }
      }
      return Effect.void
    }),
    Stream.runDrain,
  )

  // Runs on success, failure and interruption (cancel or scope close). The entry is released last,
  // so `list` never reports a run that is still writing its final state as interrupted.
  const settle = (exit: Exit.Exit<void, unknown>) =>
    Effect.gen(function* () {
      const usage = Session.getUsage({
        model: request.model,
        usage: state.usage ?? new Usage({}),
        metadata: state.metadata,
      })
      const result = outcome(exit, state.text, state.tool)
      const done: BtwItem = {
        ...item,
        status: result.status,
        answer: state.text,
        ...(result.error ? { error: result.error } : {}),
        cost: usage.cost,
        tokens: {
          input: usage.tokens.input,
          output: usage.tokens.output,
          reasoning: usage.tokens.reasoning,
          cache: { read: usage.tokens.cache.read, write: usage.tokens.cache.write },
        },
        time: { created: item.time.created, completed: Date.now() },
      }
      yield* BtwStore.finish(done)
      yield* publish(ctx, input.sessionID, done)
    }).pipe(Effect.ensuring(Effect.sync(() => release(input.sessionID, entry))))

  // Uninterruptible so a caller that goes away after the fork cannot release the entry of a run that is already going.
  // The forked child stays interruptible (forkIn defaults to that), so cancel and scope close still stop it.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const fiber = yield* run.pipe(Effect.onExit(settle), Effect.forkIn(input.scope, { startImmediately: true }))
      if (active.get(input.sessionID) === entry) entry.fiber = fiber
      return item
    }),
  )
})

export namespace KiloBtw {
  export class Busy extends Schema.TaggedErrorClass<Busy>()("KiloBtwBusy", { message: Schema.String }) {}
  export class Empty extends Schema.TaggedErrorClass<Empty>()("KiloBtwEmpty", { message: Schema.String }) {}
  export class Thread extends Schema.TaggedErrorClass<Thread>()("KiloBtwThread", { message: Schema.String }) {}
  export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()("KiloBtwUnsupported", {
    message: Schema.String,
  }) {}

  export const list = (sessionID: SessionID) => BtwStore.list(sessionID, live)

  // False when the id is not the running side question, or when its fiber is not registered yet.
  export const cancel = Effect.fn("KiloBtw.cancel")(function* (sessionID: SessionID, id: string) {
    const run = active.get(sessionID)
    if (run?.id !== id || run.fiber === undefined) return false
    yield* Fiber.interrupt(run.fiber)
    return true
  })

  export const start = Effect.fn("KiloBtw.start")(function* (input: StartInput) {
    const entry = claim(input.sessionID)
    if (!entry) return yield* new Busy({ message: "A side question is already running for this session." })
    return yield* launch(input, entry).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Effect.sync(() => release(input.sessionID, entry)) : Effect.void,
      ),
    )
  })
}
