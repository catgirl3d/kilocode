import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { messages, parse, generate } from "../../src/kilocode/branch-name"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"

function user(text: string, synthetic = false): MessageV2.WithParts {
  const sessionID = SessionID.make("ses_branch_name_test")
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: {
        providerID: ProviderV2.ID.make("kilo"),
        modelID: ModelV2.ID.make("kilo-auto/small"),
      },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID,
        type: "text",
        text,
        synthetic,
      },
    ],
  }
}

describe("branch name generation helpers", () => {
  test("sanitizes model output into a safe branch segment", () => {
    expect(parse("fix-token-refresh-race")).toBe("fix-token-refresh-race")
    expect(parse("Fix OAuth / Token Refresh!")).toBe("fix-oauth-token-refresh")
    expect(parse("добавление-функции-поиска")).toBe("dobavlenie-funktsii-poiska")
    expect(parse("fix-поиск")).toBe("fix-poisk")
    expect(parse("єдність-і-їжак-ґрунт")).toBe("yednist-i-yizhak-grunt")
    expect(parse("feature")).toBe("feature")
    expect(parse("null")).toBeNull()
    expect(parse("")).toBeNull()
    expect(parse("!!!")).toBeNull()
  })

  test("removes reasoning wrappers before parsing", () => {
    expect(parse("<think>Choose a durable outcome</think>\nadd-health-check-endpoint")).toBe(
      "add-health-check-endpoint",
    )
    expect(parse("<THINK>Choose a durable outcome</THINK>\nadd-health-check-endpoint")).toBe(
      "add-health-check-endpoint",
    )
  })

  test("uses recent real user messages and appends the pending prompt once", () => {
    const history = [user("hi"), user("internal", true), user("Can you inspect auth?")]
    expect(messages(history, "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix   the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix   the token refresh race",
    ])
  })

  test("keeps only the latest four user messages", () => {
    const history = [user("one"), user("two"), user("three"), user("four"), user("five")]
    expect(messages(history, "six")).toEqual(["three", "four", "five", "six"])
  })

  test("truncates large messages before generation", () => {
    const big = "x".repeat(2_000)

    expect(messages([user(big)], big)).toEqual(["x".repeat(1_000)])
  })

  test("uses full request options for non-Latin branch naming", async () => {
    const model = ProviderTest.model({
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    })
    const calls: LLM.StreamInput[] = []
    const results = ["add-search-function"]
    const layer = Layer.mergeAll(
      ProviderTest.fake({ model }).layer,
      Layer.mock(LLM.Service, {
        stream: (input) => {
          calls.push(input)
          return Stream.make(LLMEvent.textDelta({ id: "text", text: results.shift() ?? "" }))
        },
      }),
    )

    const result = await Effect.runPromise(
      generate({ sessionID: SessionID.make("ses_branch_name_retry"), messages: ["добавление функции поиска"] }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toBe("add-search-function")
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.retries).toBe(1)
    expect(calls.at(0)?.small).toBe(false)
    expect(calls.at(0)?.agent.prompt).toBe("")
    expect(calls.at(0)?.system).toEqual([])
    expect(calls.at(0)?.messages.at(0)?.content).toContain("Generate a Git branch name")
    expect(calls.at(0)?.messages.at(0)?.content).toContain("добавление функции поиска")
  })

  test("does not retry a null response for an English prompt", async () => {
    const model = ProviderTest.model({
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    })
    const calls: LLM.StreamInput[] = []
    const layer = Layer.mergeAll(
      ProviderTest.fake({ model }).layer,
      Layer.mock(LLM.Service, {
        stream: (input) => {
          calls.push(input)
          return Stream.make(LLMEvent.textDelta({ id: "text", text: "null" }))
        },
      }),
    )

    const result = await Effect.runPromise(
      generate({ sessionID: SessionID.make("ses_branch_name_no_retry"), messages: ["hello"] }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.small).toBe(false)
  })

  test("keeps a vague non-Latin response null without a retry", async () => {
    const model = ProviderTest.model({
      providerID: ProviderV2.ID.make("test"),
      id: ModelV2.ID.make("test-model"),
    })
    const calls: LLM.StreamInput[] = []
    const layer = Layer.mergeAll(
      ProviderTest.fake({ model }).layer,
      Layer.mock(LLM.Service, {
        stream: (input) => {
          calls.push(input)
          return Stream.make(LLMEvent.textDelta({ id: "text", text: "null" }))
        },
      }),
    )

    const result = await Effect.runPromise(
      generate({ sessionID: SessionID.make("ses_branch_name_vague_ru"), messages: ["привет"] }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls.at(0)?.small).toBe(false)
  })
})
