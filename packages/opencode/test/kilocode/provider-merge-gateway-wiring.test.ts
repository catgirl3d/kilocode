import { afterAll, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"

const cachedUsage = {
  prompt_tokens: 6042,
  completion_tokens: 118,
  total_tokens: 6160,
  prompt_tokens_details: { cached_tokens: 5533 },
}

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }]

const bodies: Record<string, unknown>[] = []

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.json())
    return Response.json({
      id: "chatcmpl-wiring",
      object: "chat.completion",
      created: 0,
      model: "zai/glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: cachedUsage,
    })
  },
})

afterAll(() => server.stop(true))

const config = {
  provider: {
    "merge-gateway": {
      name: "Merge Gateway",
      npm: "merge-gateway-ai-sdk-provider",
      api: `http://127.0.0.1:${server.port}/v1/ai-sdk`,
      models: { "zai/glm-5.3-flash": { name: "GLM 5.3 Flash" } },
      options: { apiKey: "test" },
    },
  },
}

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))

it.instance(
  "merge-gateway models resolve through the bundled patched provider",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("merge-gateway"), ModelV2.ID.make("zai/glm-5.3-flash"))
      const language = yield* provider.getLanguage(model)
      bodies.length = 0
      const result = yield* Effect.promise(() => language.doGenerate({ prompt }))
      expect(result.usage.inputTokens?.cacheRead).toBe(5533)
      expect(bodies[0]).not.toHaveProperty("reasoning_effort")
    }),
  { config },
)

it.instance(
  "merge-gateway forwards the selected reasoning effort to the gateway body",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(ProviderV2.ID.make("merge-gateway"), ModelV2.ID.make("zai/glm-5.3-flash"))
      const language = yield* provider.getLanguage(model)
      bodies.length = 0
      yield* Effect.promise(() =>
        language.doGenerate({
          prompt,
          providerOptions: ProviderTransform.providerOptions(model, { reasoningEffort: "max" }),
        }),
      )
      expect(bodies[0]?.reasoning_effort).toBe("max")
    }),
  { config },
)
