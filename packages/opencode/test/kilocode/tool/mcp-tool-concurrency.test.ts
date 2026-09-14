import path from "node:path"
import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { MessageID, SessionID } from "@/session/schema"
import { McpTool } from "@/kilocode/tool/mcp"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../../lib/effect"

const fixture = path.join(import.meta.dir, "../../fixture/mcp-lifecycle-stdio.ts")
const server = { type: "local" as const, command: [process.execPath, fixture], on_demand: true }

function context(asks: Parameters<Tool.Context["ask"]>[0][]): Tool.Context {
  return {
    sessionID: SessionID.make("ses_mcp_tool_concurrency"),
    messageID: MessageID.make("msg_mcp_tool_concurrency"),
    callID: "call_mcp_tool_concurrency",
    agent: "code",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => asks.push(input)),
  }
}

const race = {
  connected: false,
  started: undefined as Deferred.Deferred<void> | undefined,
  release: undefined as Deferred.Deferred<void> | undefined,
  config: undefined as Deferred.Deferred<void> | undefined,
  configReads: 0,
  statusReads: 0,
  events: [] as string[],
}

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(MCP.node),
    Layer.mock(MCP.Service, {
      status: () =>
        Effect.sync(() => {
          race.statusReads++
          return race.connected
            ? { server: { status: "connected" as const } }
            : { server: { status: "disabled" as const } }
        }),
      connect: () =>
        Effect.gen(function* () {
          race.events.push("connect:start")
          if (race.started) yield* Deferred.succeed(race.started, undefined)
          if (race.release) yield* Deferred.await(race.release)
          race.connected = true
          race.events.push("connect:end")
        }),
      disconnect: () =>
        Effect.sync(() => {
          race.connected = false
          race.events.push("disconnect")
        }),
    }),
    Layer.mock(Config.Service, {
      get: () =>
        Effect.gen(function* () {
          race.configReads++
          if (race.configReads === 2 && race.config) yield* Deferred.succeed(race.config, undefined)
          return { mcp: { server } }
        }),
    }),
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Truncate.node),
  ),
)

it.instance(
  "serializes concurrent connect and disconnect operations",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      race.connected = false
      race.started = started
      race.release = release
      race.config = yield* Deferred.make<void>()
      race.configReads = 0
      race.statusReads = 0
      race.events = []
      const asks: Parameters<Tool.Context["ask"]>[0][] = []
      const tool = yield* McpTool.pipe(Effect.flatMap((info) => info.init()))
      const first = yield* tool.execute({ action: "connect", name: "server" }, context(asks)).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* tool.execute({ action: "disconnect", name: "server" }, context(asks)).pipe(Effect.forkChild)
      yield* Deferred.await(race.config)
      expect(race.events).toEqual(["connect:start"])
      expect(race.statusReads).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).title).toBe("MCP connected")
      expect((yield* Fiber.join(second)).title).toBe("MCP disconnected")
      expect(race.events).toEqual(["connect:start", "connect:end", "disconnect"])
      expect(race.connected).toBe(false)
    }),
  { config: { mcp: { server } } },
)
