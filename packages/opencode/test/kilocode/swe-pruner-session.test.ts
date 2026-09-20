import type { JSONSchema7, LanguageModelV3 } from "@ai-sdk/provider"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Tool as AITool, ToolExecutionOptions } from "ai"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import type { MessageV2 } from "@/session/message-v2"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import * as Truncate from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("swe-pruner-session")
const sessionID = SessionID.make("ses_swe-pruner-session")
const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("main") })
const pruner = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("pruner") })
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

function sized(lines = 60, chars = 3_000) {
  const content = chars - (lines - 1)
  const width = Math.floor(content / lines)
  const extra = content % lines
  return Array.from({ length: lines }, (_, index) => "x".repeat(width + (index < extra ? 1 : 0))).join("\n")
}

function message(directory: string): MessageV2.Assistant {
  return {
    id: MessageID.make("msg_swe-pruner-session"),
    role: "assistant",
    parentID: MessageID.make("msg_swe-pruner-session-parent"),
    sessionID,
    mode: "build",
    agent: agent.name,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: 0 },
  }
}

function session(directory: string): Session.Info {
  return {
    id: sessionID,
    slug: "swe-pruner-session",
    projectID,
    directory,
    title: "SWE-Pruner session boundary",
    version: "test",
    permission: Permission.fromConfig({ "*": "allow" }),
    time: { created: 0, updated: 0 },
  }
}

type State = {
  readonly args: Record<string, unknown>[]
  readonly hooks: Tool.ExecuteResult[]
  readonly calls: { count: number }
  readonly defs: Tool.Def[]
}

function language(state: State, failure = false): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "pruner",
    supportedUrls: {},
    doStream: async () => {
      state.calls.count++
      if (failure) throw new Error("simulated provider failure")
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text" })
            controller.enqueue({ type: "text-delta", id: "text", delta: "1-10" })
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 3, text: undefined, reasoning: undefined },
                raw: {},
              },
            })
            controller.close()
          },
        }),
      }
    },
  } as unknown as LanguageModelV3
}

function environment(input: { enabled: boolean; truncated?: boolean; failure?: boolean }) {
  const state: State = { args: [], hooks: [], calls: { count: 0 }, defs: [] }
  const config = TestConfig.layer({
    get: () =>
      Effect.succeed({
        small_model: "test/pruner",
        experimental: { swe_pruner: input.enabled },
        sandbox: { enabled: false },
      }),
  })
  const base = Layer.mergeAll(
    config,
    Layer.mock(Agent.Service)({ get: () => Effect.succeed(agent) }),
    Layer.mock(Session.Service)({ get: () => Effect.succeed(session(process.cwd())) }),
    Layer.mock(Permission.Service)({ ask: () => Effect.succeed({ manual: false }) }),
    Layer.mock(Plugin.Service)({
      list: () => Effect.succeed([]),
      trigger: ((name: string, _input: unknown, output: unknown) =>
        Effect.sync(() => {
          if (name === "tool.execute.after") state.hooks.push(structuredClone(output) as Tool.ExecuteResult)
          return output
        })) as Plugin.Interface["trigger"],
    }),
    Layer.mock(MCP.Service)({
      clients: () => Effect.succeed({}),
      tools: () =>
        Effect.succeed({
          remote_lookup: {
            def: {
              name: "lookup",
              description: "remote lookup",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            } as MCPToolDef,
            client: {} as MCP.McpTool["client"],
            clientName: "remote",
          },
        }),
    }),
    Layer.mock(Truncate.Service)({
      output: (text: string) =>
        Effect.succeed(
          input.truncated
            ? { content: text, truncated: true as const, outputPath: "/tmp/full-output.log" }
            : { content: text, truncated: false as const },
        ),
      limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
    }),
    Layer.mock(Provider.Service)({
      getModel: (providerID, modelID) =>
        providerID === pruner.providerID && modelID === pruner.id
          ? Effect.succeed(pruner)
          : Effect.die(new Error(`unexpected model ${providerID}/${modelID}`)),
      getLanguage: () => Effect.succeed(language(state, input.failure)),
      getSmallModel: () => Effect.die(new Error("automatic model selection is forbidden")),
      defaultModel: () => Effect.die(new Error("main-model fallback is forbidden")),
    }),
    AppNodeBuilder.build(Database.node),
    RuntimeFlags.layer(),
  )
  const registry = Layer.effect(
    ToolRegistry.Service,
    Effect.gen(function* () {
      const defs = yield* Effect.forEach(["read", "grep", "bash", "edit"], (id) =>
        Tool.define(
          id,
          Effect.succeed({
            description: id,
            parameters: Schema.Struct({ value: Schema.String }),
            execute: (args) =>
              Effect.sync(() => {
                state.args.push(args as Record<string, unknown>)
                const output = sized()
                return {
                  title: id,
                  output,
                  metadata: id === "read" ? { loaded: [] } : id === "bash" ? { output } : {},
                }
              }),
          }),
        ).pipe(Effect.flatMap(Tool.init)),
      )
      state.defs.push(...defs)
      return ToolRegistry.Service.of({
        ids: () => Effect.succeed(defs.map((item) => item.id)),
        all: () => Effect.succeed(defs),
        named: () => Effect.die(new Error("unused")),
        tools: () => Effect.succeed(defs),
      })
    }),
  ).pipe(Layer.provideMerge(base))
  return { state, it: testEffect(registry) }
}

function resolve(directory: string) {
  return SessionTools.resolve({
    agent,
    model,
    session: session(directory),
    processor: {
      message: message(directory),
      ensureSnapshot: () => Effect.succeed(undefined),
      metadata: () => Effect.void,
      completeToolCall: () => Effect.succeed(undefined),
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {
      cancel: () => Effect.die(new Error("unused")),
      resolvePromptParts: () => Effect.die(new Error("unused")),
      prompt: () => Effect.die(new Error("unused")),
    },
    memoryCache: {},
  })
}

function schema(tool: AITool | undefined) {
  if (!tool) throw new Error("tool is missing")
  return (tool.inputSchema as { jsonSchema: JSONSchema7 }).jsonSchema
}

function call(tool: AITool | undefined, input: unknown) {
  if (!tool?.execute) return Effect.die(new Error("tool has no execute callback"))
  const options: ToolExecutionOptions = {
    toolCallId: "swe-pruner-call",
    messages: [],
    abortSignal: new AbortController().signal,
  }
  return Effect.tryPromise({
    try: () => Promise.resolve(tool.execute?.(input, options)),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

describe("SWE-Pruner session integration", () => {
  const disabled = environment({ enabled: false })
  disabled.it.instance("leaves every tool schema unchanged while disabled", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const tools = yield* resolve(tmp.directory)
      for (const id of ["read", "grep", "bash", "edit", "remote_lookup"]) {
        expect(schema(tools[id]).properties).not.toHaveProperty("context_focus_question")
      }
    }),
  )

  const enabled = environment({ enabled: true })
  enabled.it.instance("extends only built-in read, grep, and bash schemas without mutating definitions", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const tools = yield* resolve(tmp.directory)
      for (const id of ["read", "grep", "bash"]) {
        expect(schema(tools[id]).properties).toHaveProperty("context_focus_question")
      }
      for (const id of ["edit", "remote_lookup"]) {
        expect(schema(tools[id]).properties).not.toHaveProperty("context_focus_question")
      }
      for (const def of enabled.state.defs) {
        expect(ToolJsonSchema.fromTool(def).properties).not.toHaveProperty("context_focus_question")
      }
    }),
  )

  enabled.it.instance("strips the focus question before the tool and exposes pruned output to the after hook", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const tools = yield* resolve(tmp.directory)
      const result = (yield* call(tools.bash, {
        value: "payload",
        context_focus_question: "Find the requested evidence",
      })) as Tool.ExecuteResult

      expect(enabled.state.args.at(-1)).toEqual({ value: "payload" })
      expect(enabled.state.calls.count).toBe(1)
      expect(result.output).toStartWith("[SWE-Pruner: kept 15 of 60 output lines")
      expect(result.metadata["swePruner"]).toEqual({ kept: 15, total: 60 })
      expect(result.metadata["output"]).toBe(result.output)
      expect(enabled.state.hooks.at(-1)).toEqual(result)
    }),
  )

  const truncated = environment({ enabled: true, truncated: true })
  truncated.it.instance("bypasses pruning after the built-in truncation boundary", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const tools = yield* resolve(tmp.directory)
      const result = (yield* call(tools.bash, {
        value: "payload",
        context_focus_question: "Find evidence",
      })) as Tool.ExecuteResult

      expect(truncated.state.calls.count).toBe(0)
      expect(result.output).toBe(sized())
      expect(result.metadata["truncated"]).toBe(true)
      expect(result.metadata).not.toHaveProperty("swePruner")
      expect(truncated.state.hooks.at(-1)).toEqual(result)
    }),
  )

  const failing = environment({ enabled: true, failure: true })
  failing.it.instance("fails open before the after hook when the model request fails", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const tools = yield* resolve(tmp.directory)
      const result = (yield* call(tools.grep, {
        value: "payload",
        context_focus_question: "Find evidence",
      })) as Tool.ExecuteResult

      expect(failing.state.calls.count).toBe(1)
      expect(result.output).toBe(sized())
      expect(result.metadata).not.toHaveProperty("swePruner")
      expect(failing.state.hooks.at(-1)).toEqual(result)
    }),
  )
})
