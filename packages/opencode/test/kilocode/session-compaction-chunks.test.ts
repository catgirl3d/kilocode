import { SessionProjector } from "@opencode-ai/core/session/projector"
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as Stream from "effect/Stream"
import { LLMEvent, type LLMEvent as Event } from "@opencode-ai/llm"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { disposeTestRuntime, provideTestInstance } from "../fixture/fixture"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Snapshot } from "../../src/snapshot"
import { KiloCompactionChunks } from "../../src/kilocode/session/compaction-chunks"
import { KiloSessionCompaction } from "../../src/kilocode/session/compaction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import * as SessionProcessorModule from "../../src/session/processor"
import type { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session as SessionNs } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SyncEvent } from "../../src/sync"
import { ProviderTest } from "../fake/provider"
import { tmpdir } from "../fixture/fixture"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "../../src/effect/app-runtime"
import { makeRuntime } from "../../src/effect/run-service"
import { remove as cleanup } from "./cleanup"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Provider } from "../../src/provider/provider"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const ref = { providerID, modelID }
const agents = Layer.mock(Agent.Service)({
  get: () => Effect.succeed({ name: "compaction", mode: "primary", permission: [], options: {} } satisfies Agent.Info),
})
const previous = Flag.KILO_DB
const dbfile = path.join(os.tmpdir(), `kilo-compaction-chunks-${process.pid}-${crypto.randomUUID()}.db`)
const layer = LayerNode.compile(LayerNode.group([SessionNs.node, SessionProjector.node]))
const runtime = makeRuntime(SessionNs.Service, layer)

beforeAll(async () => {
  await fs.rm(dbfile, { force: true })
  Flag.KILO_DB = dbfile
})

afterAll(async () => {
  await runtime.dispose()
  await AppRuntime.dispose()
  await disposeTestRuntime()
  Flag.KILO_DB = previous
  await Promise.all([dbfile, `${dbfile}-wal`, `${dbfile}-shm`].map(cleanup))
})

const store = {
  updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.promise(() => svc.updateMessage(msg)),
  updatePart: <T extends MessageV2.Part>(part: T) => Effect.promise(() => svc.updatePart(part)),
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return runtime.runPromise((svc) => svc.create(input))
  },
  messages(input: Parameters<SessionNs.Interface["messages"]>[0]) {
    return runtime.runPromise((svc) => svc.messages(input))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return runtime.runPromise((svc) => svc.updateMessage(msg))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return runtime.runPromise((svc) => svc.updatePart(part))
  },
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

async function user(sessionID: SessionID, text: string) {
  const msg = await svc.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await svc.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID,
    providerID,
    parentID,
    time: { created: Date.now() },
    finish: "stop",
  }
  await svc.updateMessage(msg)
  await svc.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

function llm() {
  const queue: Array<Stream.Stream<Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<Event, unknown>)> = []

  return {
    push(stream: Stream.Stream<Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<Event, unknown>)) {
      queue.push(stream)
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function reply(text: string, capture?: (input: LLM.StreamInput) => void) {
  return (input: LLM.StreamInput) => {
    capture?.(input)
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    return Stream.make(
      LLMEvent.textStart({ id: "txt-0" }),
      LLMEvent.textDelta({ id: "txt-0", text }),
      LLMEvent.textEnd({ id: "txt-0" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
      LLMEvent.finish({ reason: "stop", usage }),
    )
  }
}

function fakeRuntime(outputTokenMax?: number, error?: MessageV2.Assistant["error"], empty = false, truncated = false) {
  const calls: string[] = []
  const bus = Bus.layer
  const processor = Layer.effect(
    SessionProcessorModule.SessionProcessor.Service,
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      return SessionProcessorModule.SessionProcessor.Service.of({
        create: Effect.fn("TestSessionProcessor.create")((input) =>
          Effect.succeed({
            get message() {
              return input.assistantMessage
            },
            updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
            metadata: Effect.fn("TestSessionProcessor.metadata")(() => Effect.void),
            ensureSnapshot: () => Effect.succeed(undefined),
            completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
            process: Effect.fn("TestSessionProcessor.process")((stream: LLM.StreamInput) =>
              Effect.gen(function* () {
                calls.push(JSON.stringify(stream.messages))
                if (error) {
                  input.assistantMessage.error = error
                  input.assistantMessage.finish = "error"
                  yield* sessions.updateMessage(input.assistantMessage)
                  return "stop" as const
                }
                const text = stream.messages.some((msg) =>
                  JSON.stringify(msg).includes("Create a new anchored summary"),
                )
                  ? "final summary"
                  : calls.length === 1
                    ? "chunk one"
                    : "chunk two"
                if (!empty)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    type: "text",
                    text,
                  })
                input.assistantMessage.finish = truncated ? "length" : "stop"
                return truncated ? ("stop" as const) : ("continue" as const)
              }),
            ),
          } satisfies SessionProcessor.Handle),
        ),
      })
    }),
  )
  const processorNode = LayerNode.make({
    service: SessionProcessorModule.SessionProcessor.Service,
    layer: processor,
    deps: [SessionNs.node],
  })
  const model = ProviderTest.model({ providerID, id: modelID, limit: { context: 10_000, output: 1_000 } })
  return {
    calls,
    rt: ManagedRuntime.make(
      LayerNode.compile(
        LayerNode.group([SessionCompaction.node, SessionNs.node, SessionProjector.node, Bus.node, EventV2Bridge.node]),
        [
          [SessionProcessorModule.SessionProcessor.node, processorNode],
          [Provider.node, ProviderTest.fake({ model }).layer],
          [Agent.node, agents],
          [RuntimeFlags.node, RuntimeFlags.layer({ outputTokenMax })],
          [
            Config.node,
            Layer.mock(Config.Service)({
              get: () => Effect.succeed({ ...{}, compaction: { reserved: 1_000 } }),
              directories: () => Effect.succeed([]),
            }),
          ],
        ],
      ),
    ),
  }
}

async function failure(error?: MessageV2.Assistant["error"], empty = false, truncated = false) {
  await using tmp = await tmpdir()
  return provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      const session = await svc.create({})
      await user(session.id, "oversized " + "x".repeat(80_000))
      await Effect.runPromise(
        KiloSessionCompaction.create({
          session: store,
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        }),
      )

      const { rt } = fakeRuntime(undefined, error, empty, truncated)
      try {
        const errors: Array<typeof SessionNs.Event.Error.data.Type> = []
        const off = await rt.runPromise(
          EventV2Bridge.Service.use((svc) =>
            svc.listen((evt) => {
              if (evt.type !== SessionNs.Event.Error.type) return Effect.void
              const data = evt.data as typeof SessionNs.Event.Error.data.Type
              if (data.sessionID === session.id) errors.push(data)
              return Effect.void
            }),
          ),
        )
        const msgs = await svc.messages({ sessionID: session.id })
        const parent = msgs.at(-1)?.info.id
        expect(parent).toBeTruthy()
        const result = await rt.runPromise(
          SessionCompaction.Service.use((svc) =>
            svc.process({
              parentID: parent!,
              messages: msgs,
              sessionID: session.id,
              auto: false,
            }),
          ),
        )
        const all = await svc.messages({ sessionID: session.id })
        const summary = all.find((msg) => msg.info.role === "assistant" && msg.info.summary)
        await rt.runPromise(off)
        return { result, summary, errors }
      } finally {
        await rt.dispose()
      }
    },
  })
}

function liveRuntime(layer: Layer.Layer<LLM.Service>, context = 10_000) {
  const model = ProviderTest.model({ providerID, id: modelID, limit: { context, output: 1_000 } })
  return ManagedRuntime.make(
    LayerNode.compile(
      LayerNode.group([
        SessionCompaction.node,
        SessionProcessorModule.SessionProcessor.node,
        SessionNs.node,
        SessionProjector.node,
        Bus.node,
        SessionStatus.node,
      ]),
      [
        [SessionSummary.node, summary],
        [Provider.node, ProviderTest.fake({ model }).layer],
        [LLM.node, layer],
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [
          Config.node,
          Layer.mock(Config.Service)({
            get: () => Effect.succeed({ ...{}, compaction: { reserved: 1_000 } }),
            directories: () => Effect.succeed([]),
          }),
        ],
      ],
    ),
  )
}

afterEach(() => {
  mock.restore()
})

describe("KiloCompactionChunks", () => {
  test("returns a retryable truncation error when a chunk processor stops at length", async () => {
    const { result, summary, errors } = await failure(undefined, false, true)
    expect(result).toBe("stop")
    expect(summary?.info).toMatchObject({
      finish: "error",
      error: {
        name: "APIError",
        data: { message: KiloCompactionChunks.TRUNCATED_SUMMARY, isRetryable: true },
      },
    })
    expect(summary?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      KiloCompactionChunks.TRUNCATED_SUMMARY,
    ])
    expect(errors).toHaveLength(1)
  })

  for (const item of [
    { context: 1_000_000, output: 128_000, boundary: 766_080, budget: 598_771 },
    { context: 200_000, output: 64_000, boundary: 150_695, budget: 118_771 },
  ]) {
    test(`preserves the split policy for a ${item.context} token window`, () => {
      const model = ProviderTest.model({ limit: { context: item.context, output: item.output } })
      const cfg = {} as Config.Info
      expect(KiloCompactionChunks.needed({ cfg, model, tokens: item.boundary })).toBe(false)
      expect(KiloCompactionChunks.needed({ cfg, model, tokens: item.boundary + 1 })).toBe(true)
      expect(KiloCompactionChunks.budget({ cfg, model })).toBe(item.budget)
    })
  }

  test("splits oversized history into chronological chunks", async () => {
    const model = ProviderTest.model({ providerID, id: modelID, limit: { context: 7_000, output: 1_000 } })
    const sessionID = SessionID.make("ses_chunks_split")
    const messages: MessageV2.WithParts[] = Array.from({ length: 4 }, (_, index) => ({
      info: {
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: MessageID.ascending(),
          sessionID,
          type: "text",
          text: `${index}: ${"x".repeat(8_000)}`,
        },
      ],
    }))

    const chunks = await Effect.runPromise(KiloCompactionChunks.split({ messages, model, size: 2_000 }))

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flatMap((chunk) => chunk.messages.map((msg) => msg.info.id))).toEqual(
      messages.map((msg) => msg.info.id),
    )
  })

  test("uses runtime output cap for fallback selection and chunk budget", () => {
    const model = ProviderTest.model({ providerID, id: modelID, limit: { context: 10_000, output: 8_000 } })
    const cfg = {} as Config.Info
    const outputTokenMax = 512

    expect(KiloCompactionChunks.needed({ cfg, model, tokens: 5_000, outputTokenMax })).toBe(false)
    expect(KiloCompactionChunks.budget({ cfg, model, outputTokenMax })).toBe(5_692)
  })

  test("preserves gateway errors from chunk workers", async () => {
    const error = new MessageV2.APIError({
      message: "The operation was aborted",
      statusCode: 504,
      isRetryable: true,
      responseBody: '{"error_type":"timeout"}',
    }).toObject()

    const result = await failure(error)

    expect(result.result).toBe("stop")
    expect(result.summary?.info.role).toBe("assistant")
    if (result.summary?.info.role !== "assistant") return
    expect(result.summary.info.finish).toBe("error")
    expect(result.summary.info.error).toEqual(error)
    expect(
      result.summary.parts.some(
        (part) => part.type === "text" && part.text.includes(KiloCompactionChunks.EMPTY_SUMMARY),
      ),
    ).toBe(false)
  })

  test("keeps context overflow on the terminal compaction path", async () => {
    const result = await failure(
      new MessageV2.ContextOverflowError({
        message: "worker context overflow",
      }).toObject(),
    )

    expect(result.errors).toHaveLength(1)
    expect(result.result).toBe("stop")
    expect(result.summary?.info.role).toBe("assistant")
    if (result.summary?.info.role !== "assistant") return
    expect(result.summary.info.error?.name).toBe("ContextOverflowError")
    if (result.summary.info.error?.name !== "ContextOverflowError") return
    expect(result.summary.info.error.data.message).toBe(
      "Session too large to compact - context exceeds model limit even after stripping media. Start a new session to continue.",
    )
  })

  test("reports empty chunk worker responses as API errors", async () => {
    const result = await failure(undefined, true)

    expect(result.errors).toHaveLength(1)
    expect(result.result).toBe("stop")
    expect(result.summary?.info.role).toBe("assistant")
    if (result.summary?.info.role !== "assistant") return
    expect(result.summary.info.finish).toBe("error")
    expect(result.summary.info.error?.name).toBe("APIError")
    if (result.summary.info.error?.name !== "APIError") return
    expect(result.summary.info.error.data.message).toBe(KiloCompactionChunks.EMPTY_SUMMARY)
    expect(result.summary.info.error.data.isRetryable).toBe(true)
    expect(
      result.summary.parts.some(
        (part) => part.type === "text" && part.text.includes(KiloCompactionChunks.EMPTY_SUMMARY),
      ),
    ).toBe(true)
  })

  test("falls back to chunk workers after the first compaction overflows", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "first " + "a".repeat(10_000))
        await assistant(session.id, first.id, tmp.path, "reply " + "b".repeat(10_000))
        const second = await user(session.id, "second " + "c".repeat(10_000))
        await assistant(session.id, second.id, tmp.path, "reply " + "d".repeat(10_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const all = await svc.messages({ sessionID: session.id })
          const summaries = all.filter((msg) => msg.info.role === "assistant" && msg.info.summary)
          const parts = summaries
            .flatMap((msg) => msg.parts)
            .filter((part): part is MessageV2.TextPart => part.type === "text")

          expect(result).toBe("continue")
          expect(calls.length).toBeGreaterThanOrEqual(1)
          expect(calls.at(-1)).toContain("Create a new anchored summary")
          expect(calls.at(-1)).toContain("<partial-summary")
          expect(calls.at(-1)?.match(/Here is the conversation so far:/g)).toHaveLength(1)
          expect(summaries).toHaveLength(1)
          expect(parts.map((part) => part.text)).toEqual(["final summary"])
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("uses chunk fallback before sending oversized normal compaction", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "first " + "a".repeat(10_000))
        await assistant(session.id, first.id, tmp.path, "reply " + "b".repeat(10_000))
        const second = await user(session.id, "second " + "c".repeat(10_000))
        await assistant(session.id, second.id, tmp.path, "reply " + "d".repeat(10_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(result).toBe("continue")
          expect(calls[0]).toContain("Summarize conversation chunk")
          expect(calls[0]).not.toContain("Create a new anchored summary")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("uses a worker even when fallback selection produces one oversized chunk", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "first " + "a".repeat(20_000))
        await assistant(session.id, first.id, tmp.path, "reply " + "b".repeat(20_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const all = await svc.messages({ sessionID: session.id })
          const summaries = all.filter((msg) => msg.info.role === "assistant" && msg.info.summary)
          const parts = summaries
            .flatMap((msg) => msg.parts)
            .filter((part): part is MessageV2.TextPart => part.type === "text")

          expect(result).toBe("continue")
          expect(calls.length).toBeGreaterThan(0)
          expect(calls[0]).toContain("Summarize conversation chunk")
          expect(summaries).toHaveLength(1)
          expect(parts.map((part) => part.text)).toEqual(["final summary"])
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("serializes oversized fallback chunks before summarizing", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "single huge request " + "a".repeat(80_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(result).toBe("continue")
          expect(calls[0]).toContain("compacted transcript")
          expect(calls[0]).toContain("Text truncated for compaction")
          expect(calls[0]).toContain("Summarize conversation chunk")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("does not send cleared reasoning text to chunk workers", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "oversized " + "x".repeat(80_000))
        const replyMessage = await assistant(session.id, first.id, tmp.path, "reply")
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replyMessage.id,
          sessionID: session.id,
          type: "reasoning",
          text: "CLEARED_REASONING_SENTINEL",
          time: { start: 1, end: 2 },
          metadata: { "kilocode.reasoning": { cleared: 1 } },
        })
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(calls.length).toBeGreaterThan(0)
          expect(calls.join("\n")).not.toContain("CLEARED_REASONING_SENTINEL")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("omits cleared reasoning from a normal compaction prompt", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "small user turn")
        const replyMessage = await assistant(session.id, first.id, tmp.path, "small reply")
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replyMessage.id,
          sessionID: session.id,
          type: "reasoning",
          text: "CLEARED_NORMAL_REASONING_SENTINEL",
          time: { start: 1, end: 2 },
          metadata: { "kilocode.reasoning": { cleared: 1 } },
        })
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replyMessage.id,
          sessionID: session.id,
          type: "reasoning",
          text: "KEPT_NORMAL_REASONING_SENTINEL",
          time: { start: 1, end: 2 },
        })
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(result).toBe("continue")
          expect(calls.length).toBeGreaterThan(0)
          expect(calls.join("\n")).toContain("KEPT_NORMAL_REASONING_SENTINEL")
          expect(calls.join("\n")).not.toContain("CLEARED_NORMAL_REASONING_SENTINEL")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("omits cleared reasoning from an oversized head chunk transcript", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const old = await user(session.id, "old " + "x".repeat(80_000))
        const oldReply = await assistant(session.id, old.id, tmp.path, "old reply")
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: oldReply.id,
          sessionID: session.id,
          type: "reasoning",
          text: "CLEARED_HEAD_REASONING_SENTINEL",
          time: { start: 1, end: 2 },
          metadata: { "kilocode.reasoning": { cleared: 1 } },
        })
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: oldReply.id,
          sessionID: session.id,
          type: "reasoning",
          text: "KEPT_HEAD_REASONING_SENTINEL " + "y".repeat(40_000),
          time: { start: 1, end: 2 },
        })
        const middle = await user(session.id, "middle")
        await assistant(session.id, middle.id, tmp.path, "middle reply")
        const latest = await user(session.id, "latest")
        await assistant(session.id, latest.id, tmp.path, "latest reply")
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const { rt, calls } = fakeRuntime()
        try {
          const raw = await svc.messages({ sessionID: session.id })
          const msgs = MessageV2.filterCompacted([...raw].reverse())
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const chunkCall = calls.find(
            (call) => call.includes("compacted transcript") && call.includes("KEPT_HEAD_REASONING_SENTINEL"),
          )
          expect(chunkCall).toBeDefined()
          expect(chunkCall).toContain("KEPT_HEAD_REASONING_SENTINEL")
          expect(chunkCall).not.toContain("CLEARED_HEAD_REASONING_SENTINEL")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("compacts oversized replay turns after overflow compaction", async () => {
    const stub = llm()
    const calls: string[] = []
    stub.push(reply("history summary"))
    stub.push(reply("replay summary", (input) => calls.push(JSON.stringify(input.messages))))

    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const old = await user(session.id, "old context")
        await assistant(session.id, old.id, tmp.path, "old reply")
        const large = await user(session.id, "large replay " + "x".repeat(40_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: true,
            overflow: true,
          }),
        )

        const rt = liveRuntime(stub.layer)
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: true,
                overflow: true,
              }),
            ),
          )

          const all = await svc.messages({ sessionID: session.id })
          const replay = all.findLast((msg) => msg.info.role === "user" && msg.info.id !== large.id)
          const part = replay?.parts.find((part): part is MessageV2.TextPart => part.type === "text")

          expect(result).toBe("continue")
          expect(calls).toHaveLength(1)
          expect(calls[0]).toContain("Summarize conversation chunk 1 of 1")
          expect(part?.text).toContain("compacted representation")
          expect(part?.text).toContain("replay summary")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("compaction must not leak maxOutputTokens into agent options", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "first " + "a".repeat(20_000))
        await assistant(session.id, first.id, tmp.path, "reply " + "b".repeat(20_000))
        const second = await user(session.id, "second " + "c".repeat(20_000))
        await assistant(session.id, second.id, tmp.path, "reply " + "d".repeat(20_000))
        await Effect.runPromise(
          KiloSessionCompaction.create({
            session: store,
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          }),
        )

        const captured: Array<{ opts: Record<string, unknown> }> = []
        const bus = Bus.layer
        const processor = Layer.effect(
          SessionProcessorModule.SessionProcessor.Service,
          Effect.gen(function* () {
            const sessions = yield* SessionNs.Service
            return SessionProcessorModule.SessionProcessor.Service.of({
              create: Effect.fn("TestSessionProcessorLeak.create")((input) =>
                Effect.succeed({
                  get message() {
                    return input.assistantMessage
                  },
                  updateToolCall: Effect.fn("TestSessionProcessorLeak.updateToolCall")(() => Effect.succeed(undefined)),
                  metadata: Effect.fn("TestSessionProcessorLeak.metadata")(() => Effect.void),
                  ensureSnapshot: () => Effect.succeed(undefined),
                  completeToolCall: Effect.fn("TestSessionProcessorLeak.completeToolCall")(() => Effect.void),
                  process: Effect.fn("TestSessionProcessorLeak.process")((stream: LLM.StreamInput) =>
                    Effect.gen(function* () {
                      captured.push({
                        opts: stream.agent.options as Record<string, unknown>,
                      })
                      const text = stream.messages.some((msg) =>
                        JSON.stringify(msg).includes("Create a new anchored summary"),
                      )
                        ? "final summary"
                        : "chunk summary"
                      yield* sessions.updatePart({
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "text",
                        text,
                      })
                      input.assistantMessage.finish = "stop"
                      return "continue" as const
                    }),
                  ),
                } satisfies SessionProcessor.Handle),
              ),
            })
          }),
        )

        const model = ProviderTest.model({
          providerID,
          id: modelID,
          limit: { context: 10_000, output: 1_000 },
        })
        const processorNode = LayerNode.make({
          service: SessionProcessorModule.SessionProcessor.Service,
          layer: processor,
          deps: [SessionNs.node],
        })
        const outputTokenMax = 512
        const rt = ManagedRuntime.make(
          LayerNode.compile(
            LayerNode.group([SessionCompaction.node, SessionNs.node, SessionProjector.node, Bus.node]),
            [
              [SessionProcessorModule.SessionProcessor.node, processorNode],
              [Provider.node, ProviderTest.fake({ model }).layer],
              [Agent.node, agents],
              [RuntimeFlags.node, RuntimeFlags.layer({ outputTokenMax })],
              [
                Config.node,
                Layer.mock(Config.Service)({
                  get: () => Effect.succeed({ ...{}, compaction: { reserved: 1_000 } }),
                  directories: () => Effect.succeed([]),
                }),
              ],
            ],
          ),
        )

        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(result).toBe("continue")
          expect(captured.length).toBeGreaterThan(0)
          // Negative assertion (the bug surfacing):
          // maxOutputTokens must not appear in agent.options that the
          // worker hands to the LLM. Today a strict OpenAI-compatible
          // upstream rejects that field with
          // Unsupported parameter(s): maxOutputTokens`.
          for (const c of captured) {
            expect(c.opts.maxOutputTokens).toBeUndefined()
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  }, 30_000)
})
