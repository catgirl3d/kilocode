import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage, type Tool } from "ai"
import z from "zod"
import { Effect, Exit, Layer, Stream } from "effect"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { LLM } from "../../../src/session/llm"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionID, MessageID } from "../../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Agent } from "../../../src/agent/agent"
import { testEffect } from "../../lib/effect"

type ConfigModel = NonNullable<NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]>["models"]>[string]

// Only synthetic keys: never a real credential.
const KEY = "sk-test-1234567890abcdefghijklmnop"
const CLEAN = "const token: string = login()"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  requests: 0,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      state.requests += 1
      const next = state.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  state.requests = 0
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

const encoder = new TextEncoder()

function stream(payload: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

function createChatStream(text = "Hello") {
  return stream(
    [
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}`)
      .join("\n\n") + "\n\ndata: [DONE]\n\n",
  )
}

function anthropicStream() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
  return stream(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
}

function createResponses() {
  const chunks = [
    { type: "response.created", response: { id: "resp-1", created_at: 1, model: "gpt-5.2", service_tier: null } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "item-1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", item_id: "item-1", delta: "Hello", logprobs: null },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ]
  return stream(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\ndata: [DONE]\n\n")
}

const MODELS = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function fixture(providerID: string, modelID: string) {
  const provider = MODELS[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return model
}

function configModel(model: ModelsDev.Model): ConfigModel {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost, tiers: undefined } : undefined,
    limit: model.limit,
    modalities: model.modalities,
    status: model.status,
    provider: model.provider,
  } as ConfigModel
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

// The codex auth loader rewrites /responses to the real ChatGPT backend, so the OAuth
// case runs without builtin plugins and the local capture server stays authoritative.
function pluginLayer() {
  const trigger = ((_name: string, _input: unknown, output: unknown) => Effect.sync(() => output)) as Plugin.Interface["trigger"]
  return Layer.mock(Plugin.Service)({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger,
  })
}

function layer(options: { native?: boolean; auth?: Auth.Info; plugins?: boolean } = {}) {
  const auth: Auth.Interface = {
    get: (providerID) => Effect.succeed(providerID === "openai" && options.auth ? options.auth : undefined),
    all: () => Effect.succeed<Record<string, Auth.Info>>(options.auth ? { openai: options.auth } : {}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }
  return AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalNativeLlm: options.native === true })],
    [Auth.node, Layer.succeed(Auth.Service, Auth.Service.of(auth))],
    ...(options.plugins === false ? ([[Plugin.node, pluginLayer()]] as const) : []),
  ])
}

const drainWith = (input: LLM.StreamInput, options: { native?: boolean; auth?: Auth.Info; plugins?: boolean } = {}) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer(options)),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

function input(input: {
  model: Provider.Model
  session: string
  system: string[]
  messages: ModelMessage[]
  tools?: Record<string, Tool>
}): LLM.StreamInput {
  const sessionID = SessionID.make(input.session)
  const agent = {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
  return {
    user: {
      id: MessageID.make(`msg-${input.session}`),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: input.model.providerID, modelID: input.model.id },
    } satisfies SessionV1.User,
    sessionID,
    model: input.model,
    agent,
    system: input.system,
    messages: input.messages,
    tools: input.tools ?? {},
  }
}

function toolset() {
  return {
    read: tool({
      description: `Read a file, including ${KEY} if present`,
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ output: "unused" }),
    }),
  }
}

const conversation: ModelMessage[] = [
  { role: "user", content: `use ${KEY}` },
  {
    role: "assistant",
    content: [
      { type: "text", text: `reading with ${KEY}` },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        input: { path: `${KEY}.env`, api_key: KEY },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: { type: "text", value: `content ${KEY}` },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: CLEAN }] },
]

describe("outbound redaction boundary", () => {
  const compatible = fixture("vivgrid", "gemini-3.1-pro-preview")
  const openai = fixture("openai", "gpt-5.2")

  const compatibleConfig = (): Partial<ConfigV1.Info> => ({
    enabled_providers: ["acme"],
    provider: {
      acme: {
        name: "Acme",
        npm: "@ai-sdk/openai-compatible",
        models: { "test-model": configModel(compatible) },
        options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
      },
    },
  })

  const openrouter = fixture("openrouter", "moonshotai/kimi-k2.5")
  const anthropic = fixture("anthropic", "claude-sonnet-4-5")

  const anthropicConfig = (): Partial<ConfigV1.Info> => ({
    enabled_providers: ["anthropic"],
    provider: {
      anthropic: {
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        models: { [anthropic.id]: configModel(anthropic) },
        options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
      },
    },
  })

  const openrouterConfig = (): Partial<ConfigV1.Info> => ({
    enabled_providers: ["openrouter"],
    provider: {
      openrouter: {
        name: "OpenRouter",
        npm: "@openrouter/ai-sdk-provider",
        api: "https://api.openai.com/v1",
        models: { [openrouter.id]: configModel(openrouter) },
        options: { apiKey: "test-openrouter-key", baseURL: `${state.server!.url.origin}/v1` },
      },
    },
  })

  const openaiConfig = (): Partial<ConfigV1.Info> => ({
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: { [openai.id]: configModel(openai) },
        options: { apiKey: "test-openai-key", baseURL: `${state.server!.url.origin}/v1` },
      },
    },
  })

  it.instance(
    "SDK payload has no key in system, messages, tool calls, tool results or tool descriptions",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/chat/completions", createChatStream())
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("acme"), ModelV2.ID.make("test-model"))

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_sdk",
            system: [`You are helpful. OPENAI_API_KEY="${KEY}"`],
            messages: conversation,
            tools: toolset(),
          }),
        )

        const capture = yield* Effect.promise(() => request)
        const rendered = JSON.stringify(capture.body)
        expect(rendered).not.toContain(KEY)
        expect(rendered).toContain("[redacted]")
        expect(rendered).toContain(CLEAN)
        // The clean tool name and call id keep their contract values.
        expect(rendered).toContain('"read"')
        expect(rendered).toContain("call-1")
      }),
    { config: compatibleConfig },
  )

  it.instance(
    "SDK re-scrubs a later step whose context already holds a read result",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/chat/completions", createChatStream())
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("acme"), ModelV2.ID.make("test-model"))

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_sdk_second",
            system: ["You are helpful."],
            messages: conversation,
          }),
        )

        const capture = yield* Effect.promise(() => request)
        expect(JSON.stringify(capture.body)).not.toContain(KEY)
        expect(JSON.stringify(capture.body)).toContain("[redacted]")
      }),
    { config: compatibleConfig },
  )

  it.instance(
    "a dirty signed reasoning block in the current tool turn produces no request",
    () =>
      Effect.gen(function* () {
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("acme"), ModelV2.ID.make("test-model"))
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const ctx = yield* InstanceRef
            if (!ctx) return yield* Effect.die("InstanceRef not provided")
            return yield* Effect.promise(() =>
              Effect.runPromise(
                LLM.Service.use((svc) =>
                  svc
                    .stream(
                      input({
                        model: resolved,
                        session: "ses_redact_signed",
                        system: ["You are helpful."],
                        messages: [
                          { role: "user", content: "Read a file" },
                          {
                            role: "assistant",
                            content: [
                              {
                                type: "reasoning",
                                text: `thinking about ${KEY}`,
                                providerOptions: { anthropic: { signature: "opaque-signature" } },
                              },
                              {
                                type: "tool-call",
                                toolCallId: "call-current",
                                toolName: "read",
                                input: { path: "a.txt" },
                              },
                            ],
                          },
                          {
                            role: "tool",
                            content: [
                              {
                                type: "tool-result",
                                toolCallId: "call-current",
                                toolName: "read",
                                output: { type: "text", value: "file contents" },
                              },
                            ],
                          },
                        ],
                      }),
                    )
                    .pipe(Stream.runDrain),
                ).pipe(Effect.provide(layer()), Effect.provideService(InstanceRef, ctx)),
              ),
            )
          }),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("MemoryRedactFailure")
        expect(state.requests).toBe(0)
        expect(state.queue.length).toBe(0)
      }),
    { config: compatibleConfig },
  )

  it.instance(
    "Anthropic sends only the signed reasoning after the affected past turn",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/messages", anthropicStream())
        const model = yield* Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(anthropic.id))
        const messages: ModelMessage[] = [1, 2, 3].flatMap((turn): ModelMessage[] => [
          { role: "user", content: `Question ${turn}` },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: turn === 2 ? `thinking ${KEY}` : `thinking ${turn}`,
                providerOptions: { anthropic: { signature: `signature-${turn}` } },
              },
              ...(turn === 1
                ? [
                    {
                      type: "reasoning" as const,
                      text: "",
                      providerOptions: { anthropic: { redactedData: "opaque-early" } },
                    },
                  ]
                : []),
              { type: "text", text: `Answer ${turn}` },
            ],
          },
        ])
        messages.push({ role: "user", content: "Continue" })
        const before = structuredClone(messages)
        yield* drainWith(input({ model, session: "ses_past_anthropic", system: [], messages }), { plugins: false })
        const capture = yield* Effect.promise(() => request)
        const body = JSON.stringify(capture.body)
        expect(body).not.toContain(KEY)
        expect(body).not.toContain("signature-1")
        expect(body).not.toContain("signature-2")
        expect(body).not.toContain("opaque-early")
        expect(body).toContain('"thinking":"thinking 3","signature":"signature-3"')
        expect(body).toContain("Answer 1")
        expect(body).toContain("Answer 2")
        expect(messages).toEqual(before)
      }),
    { config: anthropicConfig },
  )

  it.instance(
    "OpenRouter sends only the signed reasoning details after the affected past turn",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/chat/completions", createChatStream())
        const model = yield* Provider.use.getModel(ProviderV2.ID.make("openrouter"), ModelV2.ID.make(openrouter.id))
        const messages = [1, 2, 3].flatMap((turn): ModelMessage[] => [
          { role: "user", content: `Question ${turn}` },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: `thinking ${turn}`,
                providerOptions: {
                  openrouter: {
                    reasoning_details: [
                      {
                        type: "reasoning.text",
                        text: turn === 2 ? KEY : `detail ${turn}`,
                        signature: `signature-${turn}`,
                      },
                    ],
                  },
                },
              },
              { type: "text", text: `Answer ${turn}` },
            ],
          },
        ])
        messages.push({ role: "user", content: "Continue" })
        yield* drainWith(input({ model, session: "ses_past_openrouter", system: [], messages }))
        const capture = yield* Effect.promise(() => request)
        const body = JSON.stringify(capture.body)
        expect(body).not.toContain(KEY)
        expect(body).not.toContain("signature-1")
        expect(body).not.toContain("signature-2")
        expect(body).toContain('"text":"detail 3","signature":"signature-3"')
        expect(body).toContain("Answer 1")
        expect(body).toContain("Answer 2")
      }),
    { config: openrouterConfig },
  )

  it.instance(
    "OpenRouter replayed reasoning details are scrubbed in the request body",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/chat/completions", createChatStream())
        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make("openrouter"),
          ModelV2.ID.make(openrouter.id),
        )
        const details: Array<Record<string, string>> = [
          { type: "reasoning.text", text: `API_KEY=${KEY}` },
          { type: "reasoning.summary", summary: `API_KEY=${KEY}` },
        ]

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_openrouter",
            system: ["You are helpful."],
            messages: [
              { role: "user", content: "hello" },
              {
                role: "assistant",
                content: [
                  {
                    type: "reasoning",
                    text: "thinking",
                    providerOptions: { openrouter: { reasoning_details: details } },
                  },
                  { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a.txt" } },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "read",
                    output: { type: "text", value: "clean output" },
                  },
                ],
              },
            ],
          }),
        )

        const capture = yield* Effect.promise(() => request)
        const rendered = JSON.stringify(capture.body)
        expect(rendered).toContain("reasoning_details")
        expect(rendered).not.toContain(KEY)
        expect(rendered).toContain("API_KEY=[redacted]")
        // Both the replayed text and the replayed summary are scrubbed.
        expect(rendered).toContain('"summary":"API_KEY=[redacted]"')
      }),
    { config: openrouterConfig },
  )

  it.instance(
    "native payload has no key in instructions, input or tool descriptions",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/responses", createResponses())
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make(openai.id))

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_native",
            system: [`You are helpful. OPENAI_API_KEY="${KEY}"`],
            messages: conversation,
            tools: toolset(),
          }),
          { native: true },
        )

        const capture = yield* Effect.promise(() => request)
        const rendered = JSON.stringify(capture.body)
        expect(rendered).not.toContain(KEY)
        expect(rendered).toContain("[redacted]")
        expect(rendered).toContain(CLEAN)
      }),
    { config: openaiConfig },
  )

  it.instance(
    "OpenAI OAuth instructions are scrubbed before the request",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/responses", createResponses())
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make(openai.id))

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_oauth",
            system: [`You are helpful. OPENAI_API_KEY="${KEY}"`],
            messages: [{ role: "user", content: "Hello" }],
          }),
          {
            native: true,
            plugins: false,
            auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 3_600_000 },
          },
        )

        const capture = yield* Effect.promise(() => request)
        const rendered = JSON.stringify(capture.body)
        expect(rendered).not.toContain(KEY)
        expect(rendered).toContain("[redacted]")
        expect(String(capture.body.instructions ?? "")).toContain("[redacted]")
      }),
    { config: openaiConfig },
  )
})
