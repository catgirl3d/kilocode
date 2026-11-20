import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent, type LLMEvent as Event } from "@opencode-ai/llm"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { jsonSchema, type ModelMessage } from "ai"
import { Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { InstanceState } from "@/effect/instance-state"
import { KiloBtw } from "@/kilocode/btw"
import { BtwCapture } from "@/kilocode/btw/capture"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { ProviderTest } from "../../fake/provider"
import { testEffect } from "../../lib/effect"

const model = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("test-model"),
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
})

const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }

const answer = (text: string) =>
  Stream.make(
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
    LLMEvent.finish({ reason: "stop", usage }),
  )

// The LLM script is swapped per test; every request the runner sends is recorded.
const script = {
  requests: [] as LLM.StreamInput[],
  stream: (): Stream.Stream<Event, unknown> => answer("answer"),
}

// llm.stream is replaced by the script, so the language only matters to the GitLab workflow check.
const stub = {} as LanguageModelV3
const language = { current: stub, broken: false }

const llm = LayerNode.make({
  service: LLM.Service,
  layer: Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: (input) => {
        script.requests.push(input)
        return script.stream()
      },
    }),
  ),
  deps: [],
})

const provider = LayerNode.make({
  service: Provider.Service,
  layer: ProviderTest.fake({
    model,
    getLanguage: () =>
      Effect.sync(() => {
        if (language.broken) throw new Error("The provider SDK could not be loaded.")
        return language.current
      }),
  }).layer,
  deps: [],
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionProjector.node, Database.node, SessionStatus.node, LLM.node, Provider.node]),
    [
      [LLM.node, llm],
      [Provider.node, provider],
    ],
  ),
)

const withScope = <A, E, R>(use: (scope: Scope.Scope) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Scope.make(), use, (scope) => Scope.close(scope, Exit.void))

const seed = Effect.fn("test.btwSeed")(function* () {
  const sessions = yield* Session.Service
  const directory = (yield* InstanceState.context).directory
  const session = yield* sessions.create({ title: "btw runner" })
  const user = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  } satisfies SessionV1.User
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: user.id,
    type: "text",
    text: "Refactor the parser",
  })
  const assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: Date.now(), completed: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } satisfies SessionV1.Assistant
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "text",
    text: "The parser now uses a table.",
    time: { start: 1, end: 2 },
  })
  return { session, user, assistant }
})

// Polls the store until the run leaves "running". Bounded, so a stuck run fails loudly.
const settled = Effect.fn("test.btwSettled")(function* (sessionID: SessionID, id: string) {
  for (const _ of Array.from({ length: 500 })) {
    const item = (yield* KiloBtw.list(sessionID)).find((row) => row.id === id)
    if (item && item.status !== "running") return item
    yield* Effect.sleep("2 millis")
  }
  return yield* Effect.die(new Error(`side question ${id} did not settle`))
})

const text = (message: ModelMessage | undefined) => (typeof message?.content === "string" ? message.content : "")

// A captured frame for the session's latest user turn, with a tool-less definition set.
const frameOf = (sessionID: SessionID, user: SessionV1.User, messages: ModelMessage[]): LLM.StreamInput => ({
  user,
  sessionID,
  agent: { name: "build", mode: "primary", permission: [], options: {} },
  model,
  system: ["system prompt"],
  messages,
  tools: {},
  toolChoice: "auto",
})

const count = Effect.fn("test.btwCount")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db.get<{ count: number }>(
    sql`SELECT count(*) AS count FROM message WHERE session_id = ${sessionID}`,
  )
  return row?.count ?? 0
})

const sessionCost = Effect.fn("test.btwSessionCost")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db.get<{ cost: number }>(sql`SELECT cost FROM session WHERE id = ${sessionID}`)
  return row?.cost ?? 0
})

describe("KiloBtw runner", () => {
  it.instance("cold path sends the transcript with no tools and returns the answer", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.requests.length = 0
        script.stream = () => answer("answer")

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "why?", scope })
        expect(started.status).toBe("running")
        const done = yield* settled(session.id, started.id)

        expect(script.requests).toHaveLength(1)
        const request = script.requests[0]
        expect(request.tools).toEqual({})
        expect(request.toolChoice).toBe("none")
        expect(request.system).toEqual([])
        expect(text(request.messages[0])).toContain("Refactor the parser")
        expect(text(request.messages[0])).toContain("The parser now uses a table.")
        expect(text(request.messages.at(-1)).endsWith("Side question: why?")).toBe(true)
        expect(done.status).toBe("done")
        expect(done.answer).toBe("answer")
        expect((yield* KiloBtw.list(session.id)).map((item) => item.id)).toEqual([started.id])
      }),
    ),
  )

  it.instance("warm path replays the captured frame with execute stripped and no tool choice", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session, user, assistant } = yield* seed()
        script.requests.length = 0
        script.stream = () => answer("answer")

        const frame: LLM.StreamInput = {
          user,
          sessionID: session.id,
          agent: { name: "build", mode: "primary", permission: [], options: {} },
          model,
          system: ["system prompt"],
          messages: [
            { role: "user", content: "earlier turn" },
            { role: "assistant", content: "earlier answer" },
          ],
          tools: {
            read: {
              description: "read a file",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => {
                throw new Error("must not run")
              },
            },
          },
          toolChoice: "auto",
        }
        BtwCapture.record(frame, { id: assistant.id })

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "what changed?", scope })
        yield* settled(session.id, started.id)

        expect(script.requests).toHaveLength(1)
        const request = script.requests[0]
        expect(request.sessionID).toBe(session.id)
        expect(request.toolChoice).toBeUndefined()
        for (const tool of Object.values(request.tools)) {
          expect((tool as { execute?: unknown }).execute).toBeUndefined()
        }
        expect(request.messages.slice(0, 2)).toEqual(frame.messages)
        expect(text(request.messages.at(-1)).endsWith("Side question: what changed?")).toBe(true)
      }),
    ),
  )

  it.instance("does not write messages or change the session status", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () => answer("answer")
        const before = yield* count(session.id)

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "quiet?", scope })
        yield* settled(session.id, started.id)

        expect(yield* count(session.id)).toBe(before)
        const status = yield* SessionStatus.Service.use((svc) => svc.get(session.id))
        expect(status.type).toBe("idle")
      }),
    ),
  )

  it.instance("a second start while one runs fails with Busy", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        const gate = yield* Deferred.make<void>()
        script.stream = () => Stream.unwrap(Deferred.await(gate).pipe(Effect.as(answer("late"))))

        const first = yield* KiloBtw.start({ sessionID: session.id, question: "one", scope })
        const second = yield* KiloBtw.start({ sessionID: session.id, question: "two", scope }).pipe(Effect.flip)
        expect(second).toBeInstanceOf(KiloBtw.Busy)
        expect(second._tag).toBe("KiloBtwBusy")

        yield* Deferred.succeed(gate, undefined)
        expect((yield* settled(session.id, first.id)).status).toBe("done")
      }),
    ),
  )

  it.instance("cancel persists the partial answer as cancelled, unknown ids return false", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        const emitted = yield* Deferred.make<void>()
        script.stream = () =>
          Stream.concat(
            Stream.make(LLMEvent.textStart({ id: "text" }), LLMEvent.textDelta({ id: "text", text: "part" })),
            Stream.concat(Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(Stream.drain), Stream.never),
          )

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "long?", scope })
        yield* Deferred.await(emitted)

        expect(yield* KiloBtw.cancel(session.id, started.id)).toBe(true)
        expect(yield* KiloBtw.cancel(session.id, "btw_missing")).toBe(false)

        const item = (yield* KiloBtw.list(session.id)).find((row) => row.id === started.id)
        expect(item?.status).toBe("cancelled")
        expect(item?.answer).toBe("part")
      }),
    ),
  )

  it.instance("a stream that yields only a tool call ends as an error that names the tool", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () =>
          Stream.make(
            LLMEvent.toolCall({ id: "call", name: "read", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          )

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "tool?", scope })
        const done = yield* settled(session.id, started.id)

        expect(done.status).toBe("error")
        expect(done.error).toContain("tool")
      }),
    ),
  )

  it.instance("a finished item adds its cost to the session total", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () => answer("costed")
        const before = yield* sessionCost(session.id)

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "price?", scope })
        const done = yield* settled(session.id, started.id)

        expect(done.cost).toBeGreaterThan(0)
        expect(yield* sessionCost(session.id)).toBeCloseTo(before + done.cost, 10)
      }),
    ),
  )

  it.instance("a follow-up replays the earlier Q/A of its thread; an unknown thread fails", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.requests.length = 0
        script.stream = () => answer("first answer")

        const first = yield* KiloBtw.start({ sessionID: session.id, question: "one", scope })
        yield* settled(session.id, first.id)

        script.stream = () => answer("second answer")
        const follow = yield* KiloBtw.start({
          sessionID: session.id,
          question: "two",
          threadID: first.threadID,
          scope,
        })
        yield* settled(session.id, follow.id)

        const request = script.requests.at(-1)!
        expect(request.messages.at(-3)).toEqual({ role: "user", content: "Side question: one" })
        expect(request.messages.at(-2)).toEqual({ role: "assistant", content: "first answer" })
        expect(text(request.messages.at(-1)).endsWith("Side question: two")).toBe(true)
        expect(follow.threadID).toBe(first.threadID)

        const missing = yield* KiloBtw.start({
          sessionID: session.id,
          question: "three",
          threadID: "btw_unknown",
          scope,
        }).pipe(Effect.flip)
        expect(missing).toBeInstanceOf(KiloBtw.Thread)
      }),
    ),
  )

  it.instance("an empty threadID starts a new thread", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.requests.length = 0
        script.stream = () => answer("first answer")

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "one", threadID: "", scope })
        yield* settled(session.id, started.id)

        expect(started.threadID).toBe(started.id)
      }),
    ),
  )

  it.instance("a warm request ignores the open text and running tool of an in-flight assistant", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session, user } = yield* seed()
        const sessions = yield* Session.Service
        const directory = (yield* InstanceState.context).directory
        const inflight = {
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          mode: "build",
          agent: "build",
          path: { cwd: directory, root: directory },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies SessionV1.Assistant
        yield* sessions.updateMessage(inflight)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: inflight.id,
          type: "text",
          text: "half a sentence",
          time: { start: 1 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: inflight.id,
          type: "tool",
          callID: "call_running",
          tool: "read",
          state: { status: "running", input: { filePath: "src/parser.ts" }, time: { start: 2 } },
        })
        yield* SessionStatus.Service.use((svc) => svc.set(session.id, { type: "busy" }))
        const before = yield* count(session.id)
        script.requests.length = 0
        script.stream = () => answer("answer")
        BtwCapture.record(
          frameOf(session.id, user, [
            { role: "user", content: "earlier turn" },
            { role: "assistant", content: "earlier answer" },
          ]),
          { id: inflight.id },
        )

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "what now?", scope })
        yield* settled(session.id, started.id)

        expect(script.requests).toHaveLength(1)
        const request = script.requests[0]
        expect(request.toolChoice).toBeUndefined()
        expect(request.messages).toHaveLength(3)
        expect(request.messages.slice(0, 2)).toEqual([
          { role: "user", content: "earlier turn" },
          { role: "assistant", content: "earlier answer" },
        ])
        expect(JSON.stringify(request.messages)).not.toContain("half a sentence")
        expect(JSON.stringify(request.messages)).not.toContain("call_running")
        expect(yield* count(session.id)).toBe(before)
        const status = yield* SessionStatus.Service.use((svc) => svc.get(session.id))
        expect(status.type).toBe("busy")
      }),
    ),
  )

  it.instance("a pending revert sends the cold transcript without the reverted messages", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session, user, assistant } = yield* seed()
        const sessions = yield* Session.Service
        yield* sessions.setRevert({ sessionID: session.id, revert: { messageID: assistant.id }, summary: undefined })
        BtwCapture.record(frameOf(session.id, user, [{ role: "user", content: "earlier turn" }]), { id: assistant.id })
        script.requests.length = 0
        script.stream = () => answer("answer")

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "after revert?", scope })
        yield* settled(session.id, started.id)

        expect(script.requests).toHaveLength(1)
        const request = script.requests[0]
        expect(request.tools).toEqual({})
        expect(request.toolChoice).toBe("none")
        expect(text(request.messages[0])).toContain("Refactor the parser")
        expect(text(request.messages[0])).not.toContain("The parser now uses a table.")
      }),
    ),
  )

  it.instance("a warm request appends the messages written after the captured step", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session, user, assistant } = yield* seed()
        const sessions = yield* Session.Service
        // The captured step is the seeded assistant; a later completed assistant answers after it.
        const later = { ...assistant, id: MessageID.ascending(), time: { created: Date.now(), completed: Date.now() } }
        yield* sessions.updateMessage(later)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: later.id,
          type: "text",
          text: "Follow-up output.",
          time: { start: 1, end: 2 },
        })
        BtwCapture.record(
          frameOf(session.id, user, [
            { role: "user", content: "earlier turn" },
            { role: "assistant", content: "earlier answer" },
          ]),
          { id: assistant.id },
        )
        script.requests.length = 0
        script.stream = () => answer("answer")

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "and then?", scope })
        yield* settled(session.id, started.id)

        const request = script.requests[0]
        // Two frame messages, the captured assistant and the later one, then the prompt.
        expect(request.messages).toHaveLength(5)
        const appended = JSON.stringify(request.messages.slice(2, 4))
        expect(appended).toContain("The parser now uses a table.")
        expect(appended).toContain("Follow-up output.")
        expect(text(request.messages.at(-1)).endsWith("Side question: and then?")).toBe(true)
      }),
    ),
  )

  it.instance("a provider error in the stream ends the item as an error with the provider message", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () =>
          Stream.make(
            LLMEvent.textStart({ id: "text" }),
            LLMEvent.providerError({ message: "Rate limit exceeded.\nRetry in 30 seconds." }),
          )

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "limited?", scope })
        const done = yield* settled(session.id, started.id)

        expect(done.status).toBe("error")
        expect(done.error).toBe("Rate limit exceeded.")
      }),
    ),
  )

  it.instance("a stream with neither text nor a tool call ends as an error without the tool hint", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () => Stream.make(LLMEvent.finish({ reason: "stop", usage }))

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "silent?", scope })
        const done = yield* settled(session.id, started.id)

        expect(done.status).toBe("error")
        expect(done.error).toBe("The model returned no answer.")
      }),
    ),
  )

  it.instance("the captured frame is not changed by the messages a side question sends", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session, user, assistant } = yield* seed()
        script.requests.length = 0
        script.stream = () => answer("answer")
        const part = { type: "text" as const, text: "earlier turn" }
        BtwCapture.record(frameOf(session.id, user, [{ role: "user", content: [part] }]), { id: assistant.id })
        // The native runtime writes providerOptions into the messages it sends, after the frame was recorded.
        Object.assign(part, { providerOptions: { test: { run: 1 } } })
        expect(BtwCapture.get(session.id)?.input.messages).toEqual([
          { role: "user", content: [{ type: "text", text: "earlier turn" }] },
        ])

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "isolated?", scope })
        yield* settled(session.id, started.id)

        Object.assign(script.requests[0].messages[0]!, { providerOptions: { test: { run: 2 } } })
        expect(BtwCapture.get(session.id)?.input.messages).toEqual([
          { role: "user", content: [{ type: "text", text: "earlier turn" }] },
        ])
      }),
    ),
  )

  it.instance("refuses a GitLab Duo workflow model before writing anything", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.requests.length = 0
        language.current = new GitLabWorkflowLanguageModel("duo-chat", {
          provider: "gitlab.workflow",
          instanceUrl: "https://gitlab.example.com",
          getHeaders: () => ({}),
        })

        const failure = yield* KiloBtw.start({ sessionID: session.id, question: "duo?", scope }).pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.sync(() => {
              language.current = stub
            }),
          ),
        )

        expect(failure).toMatchObject({
          _tag: "KiloBtwUnsupported",
          message: "Side questions are not available for GitLab Duo workflow models.",
        })
        expect(script.requests).toHaveLength(0)
        expect(yield* KiloBtw.list(session.id)).toEqual([])
      }),
    ),
  )

  it.instance("a language that cannot be resolved is left to the run instead of failing the request", () =>
    withScope((scope) =>
      Effect.gen(function* () {
        const { session } = yield* seed()
        script.stream = () => answer("answer")
        language.broken = true

        const started = yield* KiloBtw.start({ sessionID: session.id, question: "unresolved?", scope })
        const done = yield* settled(session.id, started.id)

        expect(done.status).toBe("done")
        expect(done.answer).toBe("answer")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            language.broken = false
          }),
        ),
      ),
    ),
  )
})
