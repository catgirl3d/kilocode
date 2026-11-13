import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Queue } from "effect"
import { QuestionTool } from "../../../src/tool/question"
import { Question } from "../../../src/question"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Agent } from "../../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../../lib/effect"
import { EventV2Bridge } from "../../../src/event-v2-bridge"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node])),
)

const pending = Effect.fn("QuestionCheckpointTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

const questions = [
  {
    question: "What is your favorite color?",
    header: "Color",
    options: [
      { label: "Red", description: "The color of passion" },
      { label: "Blue", description: "The color of sky" },
    ],
    multiple: false,
  },
]

describe("tool.question checkpoint", () => {
  it.instance("records the workspace snapshot taken before asking", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const withSnapshot = { ...ctx, extra: { promptOps: { snapshot: { mark: () => Effect.succeed("snap_q") } } } }

      const fiber = yield* tool.execute({ questions }, withSnapshot).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.checkpoint).toBe("snap_q")
    }),
  )

  it.instance("has no checkpoint without a prompt snapshot", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.checkpoint).toBeUndefined()
    }),
  )

  it.instance("keeps the checkpoint on a dismissed question", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const withSnapshot = { ...ctx, extra: { promptOps: { snapshot: { mark: () => Effect.succeed("snap_q") } } } }

      const fiber = yield* tool.execute({ questions }, withSnapshot).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reject(item.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.dismissed).toBe(true)
      expect(result.metadata.checkpoint).toBe("snap_q")
    }),
  )

  it.instance("takes the checkpoint before asking", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const order: string[] = []
      const withSnapshot = {
        ...ctx,
        extra: {
          promptOps: {
            snapshot: {
              mark: () =>
                Effect.sync(() => {
                  order.push("mark")
                  return "snap_q"
                }),
            },
          },
        },
      }
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) order.push("asked")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const fiber = yield* tool.execute({ questions }, withSnapshot).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      yield* Fiber.join(fiber)
      expect(order).toEqual(["mark", "asked"])
    }),
  )
})
