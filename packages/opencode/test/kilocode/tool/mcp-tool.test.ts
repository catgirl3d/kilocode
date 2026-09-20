import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@/agent/agent"
import { Effect, Layer } from "effect"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { McpTool } from "@/kilocode/tool/mcp"
import type { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../../lib/effect"
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(MCP.node),
    LayerNode.compile(Config.node),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
  ),
)
const stdioFixture = path.join(import.meta.dir, "../../fixture/mcp-lifecycle-stdio.ts")
const server = { type: "local" as const, command: [process.execPath, stdioFixture], on_demand: true }
function context(asks: Parameters<Tool.Context["ask"]>[0][]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_mcp_tool"),
    messageID: MessageID.make("msg_mcp_tool"),
    callID: "call_mcp_tool",
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => asks.push(input)),
  }
}
it.instance(
  "lists configured servers and excludes partial entries",
  () =>
    Effect.gen(function* () {
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "list" }, context([]))
      expect(JSON.parse(result.output)).toEqual([
        { name: "server", status: "disabled", description: "Docs", on_demand: true },
      ])
    }),
  { config: { mcp: { server: { ...server, description: "Docs" }, partial: { on_demand: true } } } },
)
for (const [name, config, target] of [
  ["unknown", { server }, "missing"],
  ["non-on-demand", { server: { ...server, on_demand: undefined } }, "server"],
  ["disabled", { server: { ...server, enabled: false } }, "server"],
  ["partial", { server: { on_demand: true } }, "server"],
] as const)
  it.instance(
    "rejects " + name + " connect without asking",
    () =>
      Effect.gen(function* () {
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const mcp = yield* MCP.Service
        const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
        const before = yield* mcp.status()
        const result = yield* tool.execute({ action: "connect", name: target }, context(asks))
        expect(result.metadata.ok).toBe(false)
        expect(asks).toEqual([])
        expect(yield* mcp.status()).toEqual(before)
      }),
    { config: { mcp: config } },
  )
it.instance(
  "asks before connecting and describes next-step MCP access",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      expect(tool.description).toContain("use `execute`")
      expect(tool.description).toContain("directly exposed MCP tools")
      expect(tool.description).not.toContain("native tools")
      const result = yield* tool.execute({ action: "connect", name: "server" }, context(asks))
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ permission: "mcp", patterns: ["server"], always: ["server"] })
      expect(result.output).toContain("Check the next step for tools from this server.")
      expect(result.output).not.toContain("native tools")
      expect(result.metadata).toMatchObject({ ok: true, status: "connected" })
    }),
  { config: { mcp: { server } } },
)
it.instance(
  "does not ask or reconnect already connected server",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const mcp = yield* MCP.Service
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      yield* tool.execute({ action: "connect", name: "server" }, context(asks))
      const result = yield* tool.execute({ action: "connect", name: "server" }, context(asks))
      expect(asks).toHaveLength(1)
      expect(result.output).toContain("already connected")
      expect((yield* mcp.status()).server?.status).toBe("connected")
    }),
  { config: { mcp: { server } } },
)
it.instance(
  "reports failed status without a next-step promise when connection fails",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "connect", name: "server" }, context(asks))
      expect(result.title).toBe("MCP connect failed")
      expect(result.metadata.ok).toBe(false)
      expect(result.output).toContain('MCP server "server"')
      expect(result.output).toContain("failed")
      expect(result.output).not.toContain("Check the next step for tools from this server.")
    }),
  {
    config: {
      mcp: {
        server: {
          type: "local",
          command: [process.execPath, "definitely-missing-mcp-fixture.ts"],
          on_demand: true,
        },
      },
    },
  },
)

const authIt = testEffect(
  Layer.mergeAll(
    Layer.mock(MCP.Service, {
      status: () => Effect.succeed({ auth: { status: "needs_auth" as const } }),
      connect: () => Effect.void,
    }),
    Layer.mock(Config.Service, {
      get: () => Effect.succeed({ mcp: { auth: { type: "remote", url: "https://example.invalid", on_demand: true } } }),
    }),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
  ),
)

authIt.instance(
  "gives actionable OAuth guidance for needs_auth",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "connect", name: "auth" }, context(asks))
      expect(result.title).toBe("MCP connect failed")
      expect(result.metadata).toMatchObject({ ok: false, status: "needs_auth" })
      expect(result.output).toContain("kilo mcp auth")
      expect(result.output).not.toContain("Check the next step for tools from this server.")
    }),
  { git: true },
)

it.instance(
  "lists runtime MCP servers and excludes partial config entries",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("runtime", { type: "local", command: [process.execPath, stdioFixture] })
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "list" }, context([]))
      const items = JSON.parse(result.output)
      expect(items).toContainEqual({ name: "runtime", status: "connected", on_demand: false })
      expect(items).not.toContainEqual(expect.objectContaining({ name: "partial" }))
    }),
  { config: { mcp: { partial: { on_demand: true } } } },
)

it.instance(
  "disconnects an on-demand server and removes its tools",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const mcp = yield* MCP.Service
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      yield* mcp.connect("server")
      expect(Object.keys(yield* mcp.tools())).toContain("server_current_directory")
      const result = yield* tool.execute({ action: "disconnect", name: "server" }, context(asks))
      expect(result.title).toBe("MCP disconnected")
      expect(result.output).toContain("Its tools are no longer available on later steps.")
      expect(result.output).not.toContain("native tools")
      expect(result.metadata).toMatchObject({ ok: true, status: "disabled" })
      expect((yield* mcp.status()).server?.status).toBe("disabled")
      expect(Object.keys(yield* mcp.tools())).not.toContain("server_current_directory")
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ permission: "mcp", patterns: ["server"], always: ["server"] })
    }),
  { config: { mcp: { server } } },
)

it.instance(
  "reports already disconnected without asking",
  () =>
    Effect.gen(function* () {
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const mcp = yield* MCP.Service
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const before = yield* mcp.status()
      const result = yield* tool.execute({ action: "disconnect", name: "server" }, context(asks))
      expect(result.title).toBe("MCP already disconnected")
      expect(result.output).toContain("not connected")
      expect(result.metadata.ok).toBe(true)
      expect(asks).toEqual([])
      expect(yield* mcp.status()).toEqual(before)
    }),
  { config: { mcp: { server } } },
)

const failure = { connected: true }
const failureIt = testEffect(
  Layer.mergeAll(
    Layer.mock(MCP.Service, {
      status: () =>
        Effect.succeed(
          failure.connected
            ? { server: { status: "connected" as const } }
            : { server: { status: "failed" as const, error: "close failed" } },
        ),
      disconnect: () =>
        Effect.sync(() => {
          failure.connected = false
        }),
    }),
    Layer.mock(Config.Service, { get: () => Effect.succeed({ mcp: { server } }) }),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
  ),
)

failureIt.instance(
  "reports a disconnect close failure instead of success",
  () =>
    Effect.gen(function* () {
      failure.connected = true
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "disconnect", name: "server" }, context(asks))
      expect(result.title).toBe("MCP disconnect failed")
      expect(result.metadata).toMatchObject({ action: "disconnect", ok: false, server: "server" })
      expect(result.output).toContain("close failed")
    }),
  { config: { mcp: { server } } },
)

const failedState = { status: "failed" as "failed" | "disabled", disconnects: 0 }
const failedIt = testEffect(
  Layer.mergeAll(
    Layer.mock(MCP.Service, {
      status: () => Effect.succeed({ server: { status: failedState.status, error: "server crashed" } }),
      disconnect: () =>
        Effect.sync(() => {
          failedState.disconnects++
          failedState.status = "disabled"
        }),
    }),
    Layer.mock(Config.Service, { get: () => Effect.succeed({ mcp: { server } }) }),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
  ),
)

failedIt.instance(
  "resets a failed on-demand server through disconnect",
  () =>
    Effect.gen(function* () {
      failedState.status = "failed"
      failedState.disconnects = 0
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const result = yield* tool.execute({ action: "disconnect", name: "server" }, context(asks))
      expect(result.title).toBe("MCP disconnected")
      expect(result.metadata).toMatchObject({ action: "disconnect", ok: true, status: "disabled" })
      expect(failedState.disconnects).toBe(1)
      expect(asks).toHaveLength(1)
    }),
  { config: { mcp: { server } } },
)

for (const [name, config] of [
  ["unknown", { server }],
  ["non-on-demand", { server: { ...server, on_demand: undefined } }],
] as const)
  it.instance(
    "rejects " + name + " disconnect without asking",
    () =>
      Effect.gen(function* () {
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
        const result = yield* tool.execute(
          { action: "disconnect", name: name === "unknown" ? "missing" : "server" },
          context(asks),
        )
        expect(result.title).toBe("MCP disconnect failed")
        expect(result.metadata.ok).toBe(false)
        expect(asks).toEqual([])
      }),
    { config: { mcp: config } },
  )
