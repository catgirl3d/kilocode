import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, spyOn } from "bun:test"
import { APICallError } from "ai"
import { Context, Effect, Exit, Layer, Schedule } from "effect"
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
import { SessionRetry } from "../../src/session/retry"
import { MessageID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
    readonly calls: Effect.Effect<number>
  }
>()("@test/RetryLimitLLM") {}

class State extends Context.Service<State, { readonly queue: Script[]; calls: number }>()("@test/RetryLimitLLMState") {}

function model(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 128000, output: 4096 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  } as Provider.Model
}

function retryable429(headers?: Record<string, string>) {
  return new APICallError({
    message: "429 status code (no body)",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers ?? { "content-type": "application/json" },
    isRetryable: true,
  })
}

const stateNode = LayerNode.make({
  service: State,
  layer: Layer.sync(State, () => State.of({ queue: [], calls: 0 })),
  deps: [],
})
const llmNode = LayerNode.make({
  service: LLM.Service,
  layer: Layer.effect(
    LLM.Service,
    Effect.gen(function* () {
      const state = yield* State
      return LLM.Service.of({
        stream: () => {
          state.calls += 1
          return state.queue.shift() ?? Stream.fail(new Error("unexpected extra llm call"))
        },
      })
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
      return TestLLM.of({
        push: (item) => Effect.sync(() => state.queue.push(item)).pipe(Effect.asVoid),
        calls: Effect.sync(() => state.calls),
      })
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
const env = LayerNode.compile(root, [
  [LLM.node, llmNode],
  [RuntimeFlags.node, RuntimeFlags.layer()],
]).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, Bus.layer, SyncEvent.defaultLayer)))

const it = testEffect(env)

describe("session processor unbounded retry", () => {
  const run = (retries: number, error: unknown = retryable429(), mode: "retry" | "terminal" = "retry") =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const test = yield* TestLLM
          const processors = yield* SessionProcessor.Service
          const session = yield* Session.Service

          yield* Effect.forEach(Array.from({ length: retries }), () => test.push(Stream.fail(error)), {
            discard: true,
          })
          const usage = new Usage({})
          yield* test.push(
            Stream.make(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "text" }),
              LLMEvent.textDelta({ id: "text", text: "Recovered" }),
              LLMEvent.textEnd({ id: "text" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
              LLMEvent.finish({ reason: "stop", usage }),
            ),
          )
          yield* test.push(Stream.fail(new Error("unexpected extra llm call")))

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
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input: LLM.StreamInput = {
            user: parent as MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: { name: "code", mode: "primary", permission: [], options: {} } as any,
            system: [],
            messages: [],
            tools: {},
          }

          const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)

          try {
            const result = yield* handle.process(input)
            const calls = yield* test.calls
            const parts = yield* MessageV2.parts(msg.id)

            if (mode === "terminal") {
              expect({ result, calls }).toEqual({ result: "stop", calls: 1 })
              expect(handle.message.error).toMatchObject({
                name: "APIError",
                data: { statusCode: 400, isRetryable: false },
              })
              expect(parts.some((part) => part.type === "text" && part.text === "Recovered")).toBe(false)
              return
            }

            expect(result).toBe("continue")
            expect(calls).toBe(retries + 1)
            expect(handle.message.error).toBeUndefined()
            expect(handle.message.finish).toBe("stop")
            expect(parts.find((part) => part.type === "text")?.text).toBe("Recovered")
          } finally {
            delay.mockRestore()
          }
        }),
      { git: true },
    )

  it.live(
    "retries provider errors past the previous five-retry cap despite the obsolete env limit",
    () =>
      Effect.gen(function* () {
        const prev = process.env.KILO_SESSION_RETRY_LIMIT
        process.env.KILO_SESSION_RETRY_LIMIT = "1"
        try {
          yield* run(6)
        } finally {
          if (prev === undefined) delete process.env.KILO_SESSION_RETRY_LIMIT
          else process.env.KILO_SESSION_RETRY_LIMIT = prev
        }
      }),
    15000,
  )

  it.live(
    "retries a serialized APIError from the stream and completes the follow-up response",
    () =>
      Effect.gen(function* () {
        yield* run(1, {
          name: "APIError",
          data: {
            message: "Network connection failed",
            isRetryable: true,
            metadata: { code: "", syscall: "", message: "network connection was lost" },
          },
        })
      }),
    20_000,
  )

  it.live(
    "stops on a serialized terminal APIError without retrying or persisting response text",
    () =>
      Effect.gen(function* () {
        yield* run(
          1,
          {
            name: "APIError",
            data: {
              message: "Network connection failed",
              statusCode: 400,
              isRetryable: false,
              metadata: { code: "", syscall: "", message: "network connection was lost" },
            },
          },
          "terminal",
        )
      }),
    20_000,
  )

  const policy = (items: ("offline" | "provider")[], offlineResult: "retry" | "blocked" | "aborted" = "retry") =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const state = { offline: 0, stopped: false }
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: (error) => MessageV2.fromError(error, { providerID: ref.providerID }),
          set: (info) => Effect.sync(() => attempts.push(info.attempt)).pipe(Effect.asVoid),
          offline: () =>
            Effect.sync(() => {
              state.offline += 1
              return offlineResult
            }),
        }),
      )

      for (const item of items) {
        const result = yield* Effect.exit(
          step(item === "offline" ? new Error("fetch failed") : retryable429({ "retry-after-ms": "1" })),
        )
        if (Exit.isFailure(result)) {
          state.stopped = true
          break
        }
      }

      return { attempts, ...state }
    })

  it.live("offline reconnect resets the attempt and continues retry scheduling", () =>
    Effect.gen(function* () {
      const result = yield* policy([...Array.from({ length: 6 }, () => "offline" as const), "provider"])
      expect(result.offline).toBe(6)
      expect(result.attempts).toEqual([0, 0, 0, 0, 0, 0, 1])
      expect(result.stopped).toBe(false)
    }),
  )

  it.effect("offline rejection ends retry scheduling", () =>
    Effect.gen(function* () {
      const result = yield* policy(["offline"], "blocked")
      expect(result.offline).toBe(1)
      expect(result.attempts).toEqual([])
      expect(result.stopped).toBe(true)
    }),
  )
})
