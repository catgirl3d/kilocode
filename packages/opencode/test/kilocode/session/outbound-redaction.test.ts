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

function userText(body: unknown) {
  if (typeof body !== "object" || body === null) return
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return
  for (const message of [...messages].reverse()) {
    if (typeof message !== "object" || message === null) continue
    if ((message as { role?: unknown }).role !== "user") continue
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("")
  }
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

  it.instance(
    "a JSON file read as a tool result loses escaped named keys but keeps near misses",
    () =>
      Effect.gen(function* () {
        const request = waitRequest("/chat/completions", createChatStream())
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("acme"), ModelV2.ID.make("test-model"))
        const named = "test0123456789abcdef0123456789abc"
        const near = "abcdef1234567890xyz"
        const dsn = "DbPass1234567890"
        const file = [
          `"input": "MISTRAL_API_KEY=\\"${named}\\"",`,
          `"other": "token_type=\\"${near}\\"",`,
          `"dsn": "postgres://app:${dsn}@db.example.test/app",`,
        ].join("\n")

        yield* drainWith(
          input({
            model: resolved,
            session: "ses_redact_json_tool",
            system: [],
            messages: [
              { role: "user", content: "Read the corpus file" },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-json",
                    toolName: "read",
                    input: { path: "text-cases.json" },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-json",
                    toolName: "read",
                    output: { type: "text", value: file },
                  },
                ],
              },
            ],
          }),
        )

        const capture = yield* Effect.promise(() => request)
        const rendered = JSON.stringify(capture.body)
        expect(rendered).not.toContain(named)
        expect(rendered).not.toContain(dsn)
        expect(rendered).toContain("[redacted]")
        expect(rendered).toContain(near)
        expect(rendered).toContain("postgres://[redacted]@db.example.test/app")
      }),
    { config: compatibleConfig },
  )

  const nl = String.fromCharCode(10)
  const rules: Array<{ id: string; input: string; secret: string; expected?: string }> = [
    { id: "query-param", input: "https://x.test/?access_token=abc1234567890123&x=1", secret: "abc1234567890123" },
    { id: "bracket-array", input: "password[]=Secret123", secret: "Secret123" },
    { id: "bracket-index", input: "password[0]=Secret123", secret: "Secret123" },
    { id: "cli-password", input: "tool --password Secret123", secret: "Secret123" },
    { id: "mysql-p", input: "mysql -pSecret123", secret: "Secret123" },
    { id: "curl-user", input: "curl -u alice:CurlSecret123456 https://example.test", secret: "CurlSecret123456" },
    { id: "pgpass", input: "db.test:5432:app:alice:PgPassSecret123", secret: "PgPassSecret123" },
    {
      id: "netrc",
      input: "machine db.test login alice password NetrcSecret123",
      secret: "NetrcSecret123",
    },
    { id: "setx", input: "setx PASSWORD WinSecret123", secret: "WinSecret123" },
    { id: "yaml-block", input: `password: |${nl}  Secret123`, secret: "Secret123", expected: "password: [redacted]" },
    {
      id: "triple-quotes",
      input: 'password = """Secret123"""',
      secret: "Secret123",
      expected: "password = [redacted]",
    },
    {
      id: "heredoc",
      input: `password=$(cat <<EOF${nl}Secret123${nl}EOF)`,
      secret: "Secret123",
      expected: "password=[redacted]",
    },
    { id: "google-oauth", input: "GOCSPX-demoA1b2C3d4E5f6G7h8", secret: "GOCSPX-demoA1b2C3d4E5f6G7h8" },
    { id: "shopify", input: "shpat_demoA1b2C3d4E5f6", secret: "shpat_demoA1b2C3d4E5f6" },
    { id: "linear", input: "lin_api_demoLinearA1b2C3d4", secret: "lin_api_demoLinearA1b2C3d4" },
    { id: "replicate", input: "r8_demoReplicateA1b2C3d4", secret: "r8_demoReplicateA1b2C3d4" },
    { id: "perplexity", input: "pplx-demoPerplexityA1b2C3d4", secret: "pplx-demoPerplexityA1b2C3d4" },
    { id: "square", input: "sq0csp-demoSecretA1b2C3d4", secret: "sq0csp-demoSecretA1b2C3d4" },
    { id: "age", input: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQ", secret: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQ" },
    { id: "mailgun", input: "key-demoMailgunA1b2C3d4E5f6G7h8", secret: "key-demoMailgunA1b2C3d4E5f6G7h8" },
    { id: "notion", input: "secret_demoNotionA1b2C3d4", secret: "secret_demoNotionA1b2C3d4" },
    {
      id: "discord",
      input: "MTIzNDU2Nzg5MDEyMzQ1Njc4.A1b2C3.abcdefghijklmnopqrstuvwxyz1",
      secret: "MTIzNDU2Nzg5MDEyMzQ1Njc4.A1b2C3.abcdefghijklmnopqrstuvwxyz1",
    },
    {
      id: "telegram",
      input: "123456789:AA_demoToken1234567890abcdefgh",
      secret: "123456789:AA_demoToken1234567890abcdefgh",
    },
    {
      id: "azure-sas",
      input: "https://example.test/blob?sv=2026&sig=AzureSecret123456",
      secret: "AzureSecret123456",
    },
    {
      id: "s3-presign",
      input: "https://s3.example.test/object?X-Amz-Signature=abcdef0123456789abcdef",
      secret: "abcdef0123456789abcdef",
    },
    {
      id: "sigv4",
      input:
        "Authorization: AWS4-HMAC-SHA256 Credential=AKIA1234567890ABCDEF/20261120/x, Signature=abcdef0123456789abcdef0123456789",
      secret: "abcdef0123456789abcdef0123456789",
      expected: "Authorization: AWS4-HMAC-SHA256 Credential=[redacted], Signature=[redacted]",
    },
    { id: "cookie-session", input: "Cookie: session=CookieSecret123456; theme=dark", secret: "CookieSecret123456" },
    { id: "header-api-key", input: "X-Api-Key: abcdefghijklmnop", secret: "abcdefghijklmnop" },
    {
      id: "mysql-bracket",
      input: "mysql -pSecret123] next",
      secret: "Secret123",
      expected: "mysql -p[redacted]] next",
    },
    {
      id: "email-amp",
      input: "user@example.com:Secret123&next=1",
      secret: "Secret123",
      expected: "user@example.com:[redacted]&next=1",
    },
    {
      id: "command-quoted",
      input: 'password=$(printf "x)"; echo Secret123)',
      secret: "Secret123",
      expected: "password=[redacted]",
    },
    { id: "setx-upper", input: "SETX PASSWORD Secret123", secret: "Secret123", expected: "SETX PASSWORD [redacted]" },
    {
      id: "cookie-mixed",
      input: "cOOkie: session=CookieSecret123456; theme=dark",
      secret: "CookieSecret123456",
      expected: "cOOkie: session=[redacted]; theme=dark",
    },
    {
      id: "cli-json-tail",
      input: '{"cmd":"tool --password Secret123\\"x","keep":1}',
      secret: "Secret123",
      expected: '{"cmd":"tool --password [redacted]\\"x","keep":1}',
    },
    {
      id: "escaped-inner",
      input: '{"input":"password=\\"prefix\\"test0123456789abcdef0123456789abc\\""}',
      secret: "test0123456789abcdef0123456789abc",
      expected: '{"input":"password=\\"[redacted]\\""}',
    },
    {
      id: "opencode-console",
      input: "oc_sk_" + "0123456789ab_" + "a".repeat(39),
      secret: "oc_sk_" + "0123456789ab_" + "a".repeat(39),
      expected: "[redacted]",
    },
    {
      id: "aws-access-id-variant",
      input: "A3T" + "A".repeat(17),
      secret: "A3T" + "A".repeat(17),
      expected: "[redacted]",
    },
    {
      id: "bedrock",
      input: "ABSK" + "A".repeat(100),
      secret: "ABSK" + "A".repeat(100),
      expected: "[redacted]",
    },
    {
      id: "doppler",
      input: "dp.pt." + "a".repeat(32),
      secret: "dp.pt." + "a".repeat(32),
      expected: "[redacted]",
    },
    {
      id: "stripe-test",
      input: "sk_test_" + "a".repeat(20),
      secret: "sk_test_" + "a".repeat(20),
      expected: "[redacted]",
    },
    {
      id: "gitlab-dotted",
      input: "glpat-" + "a".repeat(20) + ".ab." + "c".repeat(9),
      secret: "glpat-" + "a".repeat(20) + ".ab." + "c".repeat(9),
      expected: "[redacted]",
    },
    {
      id: "slack-webhook",
      input: "https://hooks.slack.com/services/T000/B000/XXXX",
      secret: "https://hooks.slack.com/services/T000/B000/XXXX",
      expected: "[redacted]",
    },
    {
      id: "kilo-auth-content",
      input: 'KILO_AUTH_CONTENT={"azure":{"key":"abc123"}}',
      secret: '{"azure":{"key":"abc123"}}',
      expected: "KILO_AUTH_CONTENT=[redacted]",
    },
    {
      id: "authorization-token",
      input: "Authorization: Token " + "a".repeat(32),
      secret: "a".repeat(32),
      expected: "Authorization: Token [redacted]",
    },
    {
      id: "cli-api-key",
      input: "tool --api-key " + "a".repeat(20),
      secret: "a".repeat(20),
      expected: "tool --api-key [redacted]",
    },
    {
      id: "supabase-service-role",
      input: "SUPABASE_SERVICE_ROLE_KEY=" + "a".repeat(32),
      secret: "a".repeat(32),
      expected: "SUPABASE_SERVICE_ROLE_KEY=[redacted]",
    },
    {
      id: "service-role",
      input: "SERVICE_ROLE_KEY=" + "a".repeat(32),
      secret: "a".repeat(32),
      expected: "SERVICE_ROLE_KEY=[redacted]",
    },
  ]

  const cases = rules.map((rule) => ({
    ...rule,
    expected: rule.expected ?? rule.input.split(rule.secret).join("[redacted]"),
  }))

  for (const rule of cases) {
    it.instance(
      `sends no unredacted value for ${rule.id}`,
      () =>
        Effect.gen(function* () {
          const request = waitRequest("/chat/completions", createChatStream())
          const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("acme"), ModelV2.ID.make("test-model"))
          yield* drainWith(
            input({
              model: resolved,
              session: `ses_rule_${rule.id}`,
              system: [],
              messages: [{ role: "user", content: rule.input }],
            }),
          )
          const capture = yield* Effect.promise(() => request)
          const rendered = JSON.stringify(capture.body)
          expect(rendered).not.toContain(rule.secret)
          expect(rendered).toContain("[redacted]")
          // The exact surrounding bytes must survive, not just the marker.
          expect(userText(capture.body), rule.id).toBe(rule.expected)
        }),
      { config: compatibleConfig },
    )
  }
})
