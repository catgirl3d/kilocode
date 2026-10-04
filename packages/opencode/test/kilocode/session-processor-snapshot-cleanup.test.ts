import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, Usage, type LLMEvent as Event } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "../../src/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirProject } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

Log.init({ print: false })

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

type Script = Stream.Stream<Event, unknown>

class TestLLM extends Context.Service<
  TestLLM,
  {
    readonly push: (stream: Script) => Effect.Effect<void>
    readonly reply: (...events: Event[]) => Effect.Effect<void>
  }
>()("@test/SnapshotCleanupLLM") {}

class State extends Context.Service<State, { readonly queue: Script[] }>()("@test/SnapshotCleanupState") {}

const model = (): Provider.Model =>
  ({
    id: ref.modelID,
    providerID: ref.providerID,
    name: "Test",
    limit: { context: 128000, output: 4096 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  }) as Provider.Model

const stateNode = LayerNode.make({
  service: State,
  layer: Layer.sync(State, () => State.of({ queue: [] })),
  deps: [],
})
const llmNode = LayerNode.make({
  service: LLM.Service,
  layer: Layer.effect(
    LLM.Service,
    Effect.gen(function* () {
      const state = yield* State
      return LLM.Service.of({ stream: () => state.queue.shift() ?? Stream.empty })
    }),
  ),
  deps: [stateNode],
})
const testNode = LayerNode.make({
  service: TestLLM,
  layer: Layer.effect(
    TestLLM,
    Effect.gen(function* () {
      const state = yield* State
      const push = (stream: Script) => Effect.sync(() => state.queue.push(stream)).pipe(Effect.asVoid)
      return TestLLM.of({ push, reply: (...events) => push(Stream.make(...events)) })
    }),
  ),
  deps: [stateNode],
})
const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  AgentSvc.node,
  Permission.node,
  Plugin.node,
  Config.node,
  SessionSummary.node,
  Image.node,
  SessionStatus.node,
  EventV2Bridge.node,
  Database.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LLM.node,
  testNode,
])

const tracks = new Map<string, number>()
const snapshotNode = LayerNode.make({
  service: Snapshot.Service,
  layer: Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: (opts) =>
        Effect.sync(() => {
          const key = opts?.messageID ?? "test"
          const count = tracks.get(key) ?? 0
          tracks.set(key, count + 1)
          return count === 0 ? "baseline" : "finish"
        }),
      patch: () => Effect.succeed({ hash: "patch", files: ["changed.txt"] }),
      restore: () => Effect.void,
      revert: () => Effect.void,
      diff: () => Effect.succeed("diff"),
      diffFull: () => Effect.succeed([{ file: "changed.txt", additions: 1, deletions: 0 }]),
      diffFile: () => Effect.succeed(undefined),
    }),
  ),
  deps: [],
})
const summaryChecks = new Map<string, Array<{ terminal: boolean }>>()
const summaryNode = LayerNode.make({
  service: SessionSummary.Service,
  layer: Layer.effect(
    SessionSummary.Service,
    Effect.gen(function* () {
      const session = yield* Session.Service
      return SessionSummary.Service.of({
        summarize: (input) =>
          Effect.gen(function* () {
            const messages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
            const checks = summaryChecks.get(input.sessionID) ?? []
            checks.push({
              terminal: messages.some((item) =>
                item.parts.some((part) => part.type === "step-finish" && Boolean(part.snapshot)),
              ),
            })
            summaryChecks.set(input.sessionID, checks)
          }),
        diff: () => Effect.succeed([]),
        computeDiff: () => Effect.succeed([{ file: "changed.txt", additions: 1, deletions: 0 }]),
      })
    }),
  ),
  deps: [Session.node],
})
const it = testEffect(
  LayerNode.compile(root, [
    [LLM.node, llmNode],
    [Snapshot.node, snapshotNode],
    [SessionSummary.node, summaryNode],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

const setup = Effect.fn("SnapshotCleanupTest.setup")(function* (dir: string) {
  const test = yield* TestLLM
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "code",
    model: ref,
    time: { created: Date.now() },
  })
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: chat.id,
    parentID: parent.id,
    mode: "code",
    agent: "code",
    path: { cwd: path.resolve(dir), root: path.resolve(dir) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  const mdl = model()
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
  const input: LLM.StreamInput = {
    user: parent as MessageV2.User,
    sessionID: chat.id,
    model: mdl,
    agent: { name: "code", mode: "primary", permission: [], options: {} } as AgentSvc.Info,
    system: [],
    messages: [],
    tools: {},
  }
  return { test, session, msg, handle, input }
})

describe("session processor snapshot cleanup", () => {
  it.live("persists an abnormal provider-error checkpoint before invoking summary", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)
          expect(yield* ctx.handle.ensureSnapshot()).toBe("baseline")
          ctx.handle.message.cost = 7
          ctx.handle.message.tokens = { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }
          yield* ctx.test.reply(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "partial" }),
            LLMEvent.textDelta({ id: "partial", text: "Partial" }),
            LLMEvent.textEnd({ id: "partial" }),
            LLMEvent.providerError({ message: "provider boom" }),
          )
          expect(yield* ctx.handle.process(ctx.input)).toBe("stop")
          const parts = yield* MessageV2.parts(ctx.msg.id)
          const finishes = parts.filter((part) => part.type === "step-finish")
          expect(finishes).toHaveLength(1)
          expect(finishes[0]).toMatchObject({ snapshot: "finish", cost: 0 })
          expect(finishes[0]?.type === "step-finish" ? finishes[0].tokens : undefined).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          })
          expect(parts.some((part) => part.type === "patch")).toBe(true)
          expect(parts.findIndex((part) => part.type === "step-finish")).toBeLessThan(
            parts.findIndex((part) => part.type === "patch"),
          )
          yield* pollWithTimeout(Effect.sync(() => summaryChecks.get(ctx.msg.sessionID)?.[0]), "summary was not invoked")
          expect(summaryChecks.get(ctx.msg.sessionID)).toEqual([{ terminal: true }])
        }),
      { git: true },
    ),
    15_000,
  )

  it.live("persists an abnormal abort checkpoint without duplicating the terminal part", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)
          expect(yield* ctx.handle.ensureSnapshot()).toBe("baseline")
          yield* ctx.test.push(Stream.make(LLMEvent.stepStart({ index: 0 })).pipe(Stream.concat(Stream.never)))
          const fiber = yield* Effect.forkChild(ctx.handle.process(ctx.input))
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const parts = yield* MessageV2.parts(ctx.msg.id)
              return parts.some((part) => part.type === "step-start") ? true : undefined
            }),
            "aborted processor did not start its step",
          )
          yield* Fiber.interrupt(fiber)
          const parts = yield* MessageV2.parts(ctx.msg.id)
          const finishes = parts.filter((part) => part.type === "step-finish")
          expect(finishes).toHaveLength(1)
          expect(finishes[0]).toMatchObject({ snapshot: "finish", cost: 0 })
          expect(parts.some((part) => part.type === "patch")).toBe(true)
          expect(parts.findIndex((part) => part.type === "step-finish")).toBeLessThan(
            parts.findIndex((part) => part.type === "patch"),
          )
          yield* pollWithTimeout(Effect.sync(() => summaryChecks.get(ctx.msg.sessionID)?.[0]), "abort summary was not invoked")
          expect(summaryChecks.get(ctx.msg.sessionID)).toEqual([{ terminal: true }])
        }),
      { git: true },
    ),
    15_000,
  )

  it.live("does not persist a terminal checkpoint or invoke summary without a baseline", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)
          yield* ctx.test.reply(LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "provider boom" }))
          expect(yield* ctx.handle.process(ctx.input)).toBe("stop")
          const parts = yield* MessageV2.parts(ctx.msg.id)
          expect(parts.some((part) => part.type === "step-finish" || part.type === "patch")).toBe(false)
          expect(summaryChecks.get(ctx.msg.sessionID)).toBeUndefined()
        }),
      { git: true },
    ),
    15_000,
  )

  it.live("does not add a synthetic checkpoint after a normal step finish", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)
          expect(yield* ctx.handle.ensureSnapshot()).toBe("baseline")
          yield* ctx.test.reply(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.stepFinish({ index: 0, reason: "stop", usage: new Usage({}) }),
            LLMEvent.finish({ reason: "stop", usage: new Usage({}) }),
          )
          expect(yield* ctx.handle.process(ctx.input)).toBe("continue")
          const parts = yield* MessageV2.parts(ctx.msg.id)
          expect(parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
          yield* pollWithTimeout(Effect.sync(() => summaryChecks.get(ctx.msg.sessionID)?.[0]), "normal summary was not invoked")
          expect(summaryChecks.get(ctx.msg.sessionID)).toEqual([{ terminal: true }])
        }),
      { git: true },
    ),
    15_000,
  )
})
