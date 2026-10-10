import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { streamText } from "ai"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createMergeGateway } from "merge-gateway-ai-sdk-provider"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { KILO_BUNDLED_PROVIDERS } from "../../src/kilocode/provider/provider"

const cachedUsage = {
  prompt_tokens: 6042,
  completion_tokens: 118,
  total_tokens: 6160,
  prompt_tokens_details: { cached_tokens: 5533 },
}

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }]

function completion(usage: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "zai/glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function part(delta: Record<string, unknown>, extra: { finish?: string; usage?: Record<string, unknown> } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "zai/glm-5.3-flash",
    choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  }
}

function stream(chunks: unknown[]) {
  return new Response(chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function gateway(handler: (input: unknown, init?: RequestInit) => Promise<Response>) {
  return createMergeGateway({ apiKey: "test", fetch: handler as unknown as typeof globalThis.fetch })
}

describe("merge-gateway cache usage", () => {
  test("doGenerate keeps cached tokens from prompt_tokens_details", async () => {
    const model = gateway(async () => completion(cachedUsage)).chat("zai/glm-5.3-flash")
    const result = await model.doGenerate({ prompt })
    expect(result.usage.inputTokens?.cacheRead).toBe(5533)
    expect(result.usage.inputTokens?.total).toBe(6042)
  })

  test("doStream keeps cached tokens and still streams thinking", async () => {
    const model = gateway(async () =>
      stream([
        part({ role: "assistant", thinking: "think" }),
        part({ content: "ok" }),
        part({}, { finish: "stop", usage: cachedUsage }),
      ]),
    ).chat("zai/glm-5.3-flash")
    const { stream: chunks } = await model.doStream({ prompt })
    let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined
    const thinking: string[] = []
    for await (const item of chunks) {
      if (item.type === "reasoning-delta") thinking.push(item.delta)
      if (item.type === "finish") finish = item
    }
    expect(thinking.join("")).toBe("think")
    expect(finish?.usage?.inputTokens?.cacheRead).toBe(5533)
  })

  test("responses without cache details parse and zero reads stay zero", async () => {
    const plain = await gateway(async () => completion({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }))
      .chat("zai/glm-5.3-flash")
      .doGenerate({ prompt })
    expect(plain.usage.inputTokens?.cacheRead).toBeUndefined()

    const zero = await gateway(async () =>
      completion({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    )
      .chat("zai/glm-5.3-flash")
      .doGenerate({ prompt })
    expect(zero.usage.inputTokens?.cacheRead).toBe(0)
  })

  test("malformed cache details degrade instead of failing the response", async () => {
    const wrong = await gateway(async () =>
      completion({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: "5533" },
      }),
    )
      .chat("zai/glm-5.3-flash")
      .doGenerate({ prompt })
    expect(wrong.usage.inputTokens?.cacheRead).toBeUndefined()
    expect(wrong.usage.inputTokens?.total).toBe(100)

    const junk = await gateway(async () =>
      completion({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: "garbage" }),
    )
      .chat("zai/glm-5.3-flash")
      .doGenerate({ prompt })
    expect(junk.usage.inputTokens?.cacheRead).toBeUndefined()
    expect(junk.usage.inputTokens?.total).toBe(100)
  })

  test("AI SDK finish-step exposes cached tokens to the session usage path", async () => {
    const model = gateway(async () =>
      stream([part({ content: "ok" }), part({}, { finish: "stop", usage: cachedUsage })]),
    ).chat("zai/glm-5.3-flash")
    const result = streamText({ model, prompt: "hi" })
    let read: number | undefined
    for await (const item of result.fullStream) {
      if (item.type === "finish-step")
        read = item.usage.inputTokenDetails?.cacheReadTokens ?? item.usage.cachedInputTokens
    }
    expect(read).toBe(5533)
  })

  test("session adapter maps provider cache reads into step-finish usage", async () => {
    const model = gateway(async () =>
      stream([part({ content: "ok" }), part({}, { finish: "stop", usage: cachedUsage })]),
    ).chat("zai/glm-5.3-flash")
    const result = streamText({ model, prompt: "hi" })
    const state = LLMAISDK.adapterState()
    let read: number | undefined
    for await (const item of result.fullStream) {
      const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, item))
      for (const event of events) {
        if (event.type === "step-finish") read = event.usage?.cacheReadInputTokens
      }
    }
    expect(read).toBe(5533)
  })

  test("cache_control provider options reach the gateway request body", async () => {
    const bodies: unknown[] = []
    const model = gateway(async (_input, init) => {
      const raw = typeof init?.body === "string" ? init.body : "{}"
      bodies.push(JSON.parse(raw))
      return completion(cachedUsage)
    }).chat("zai/glm-5.3-flash")

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
          ],
        },
      ],
    })
    expect(bodies[0]).toMatchObject({ messages: [{ content: [{}, { cache_control: { type: "ephemeral" } }] }] })

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
          ],
        },
      ],
    })
    expect(bodies[1]).toMatchObject({ messages: [{ cache_control: { type: "ephemeral" } }] })
  })

  test("bundled registry resolves merge-gateway to the patched provider", async () => {
    const factory = await KILO_BUNDLED_PROVIDERS["merge-gateway-ai-sdk-provider"]()
    const sdk = factory({ apiKey: "test", fetch: async () => completion(cachedUsage) })
    const result = await sdk.languageModel("zai/glm-5.3-flash").doGenerate({ prompt })
    expect(result.usage.inputTokens?.cacheRead).toBe(5533)
  })
})
