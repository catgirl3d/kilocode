import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceBootstrap as InstanceBootstrapNode } from "../../src/project/bootstrap"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"

process.env["KILO_CLIENT"] = "cli"

const KEY = ["sk", "proj", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-")
const REDACTED = "[redacted]"

type Captured = {
  generate: LanguageModelV3CallOptions[]
  stream: LanguageModelV3CallOptions[]
}

function model(captured: Captured): LanguageModelV3 {
  const object = JSON.stringify({ identifier: "helper", whenToUse: "always", systemPrompt: "Use the helper" })
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "gpt-5.2",
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      captured.generate.push(options)
      return {
        content: [{ type: "text", text: object }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 12 },
          outputTokens: { total: 8 },
          raw: {},
        },
        warnings: [],
        providerMetadata: {},
        request: {},
        response: {},
      }
    },
    doStream: async (options: LanguageModelV3CallOptions) => {
      captured.stream.push(options)
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text" })
          controller.enqueue({ type: "text-delta", id: "text", delta: object })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 12, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 8, text: undefined, reasoning: undefined },
              raw: {},
            },
          })
          controller.close()
        },
      })
      return { stream }
    },
  } as unknown as LanguageModelV3
}

type Harness = {
  redact: boolean
  oauth?: boolean
  pluginKey?: string
}

function harness(input: Harness) {
  const captured: Captured = { generate: [], stream: [] }
  const provider = ProviderTest.fake({ getLanguage: () => Effect.succeed(model(captured)) })
  const config = TestConfig.layer({
    getGlobal: () => Effect.succeed({ experimental: { redact_secrets: input.redact } }),
  })

  const auth: Auth.Interface = {
    get: (providerID) =>
      Effect.succeed(
        input.oauth && providerID === provider.model.providerID
          ? ({ type: "oauth", refresh: "refresh", access: "access", expires: 0 } as Auth.Info)
          : undefined,
      ),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }

  // The hook output shape comes from the hook name, so the cast is the boundary.
  const trigger = ((_name: string, _input: unknown, output: unknown) => {
    const system = output && typeof output === "object" && "system" in output ? output.system : undefined
    if (input.pluginKey && Array.isArray(system)) system.push(input.pluginKey)
    return Effect.succeed(output)
  }) as Plugin.Interface["trigger"]

  const layer = AppNodeBuilder.build(Agent.node, [
    [MCP.node, Layer.mock(MCP.Service)({})],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [Config.node, config],
    [Provider.node, provider.layer],
    [Auth.node, Layer.succeed(Auth.Service, Auth.Service.of(auth))],
    [Plugin.node, Layer.mock(Plugin.Service)({ trigger, init: () => Effect.void, list: () => Effect.succeed([]) })],
    [Skill.node, Layer.mock(Skill.Service)({ dirs: () => Effect.succeed([]) })],
    [
      InstanceBootstrapNode.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ])
  return { captured, it: testEffect(layer) }
}

afterEach(async () => {
  await disposeAllInstances()
})

const redacting = harness({ redact: true })
const plain = harness({ redact: false })
const oauth = harness({ redact: true, oauth: true, pluginKey: `model access: ${KEY}` })

redacting.it.instance("Agent.generate redacts a secret in the outbound messages", () =>
  Effect.gen(function* () {
    yield* Agent.use.generate({ description: `Use key ${KEY} in the helper` })
    expect(redacting.captured.generate).toHaveLength(1)
    const prompt = JSON.stringify(redacting.captured.generate[0].prompt)
    expect(prompt).toContain(REDACTED)
    expect(prompt).not.toContain(KEY)
  }),
)

plain.it.instance("Agent.generate keeps the secret when redaction is disabled", () =>
  Effect.gen(function* () {
    yield* Agent.use.generate({ description: `Use key ${KEY} in the helper` })
    expect(plain.captured.generate).toHaveLength(1)
    const prompt = JSON.stringify(plain.captured.generate[0].prompt)
    expect(prompt).toContain(KEY)
    expect(prompt).not.toContain(REDACTED)
  }),
)

oauth.it.instance("Agent.generate scrubs providerOptions.instructions on the OpenAI OAuth path", () =>
  Effect.gen(function* () {
    yield* Agent.use.generate({ description: `Use key ${KEY} in the helper` })
    expect(oauth.captured.stream).toHaveLength(1)
    const options = JSON.stringify(oauth.captured.stream[0].providerOptions)
    expect(options).toContain("model access")
    expect(options).toContain(REDACTED)
    expect(options).not.toContain(KEY)
  }),
)
