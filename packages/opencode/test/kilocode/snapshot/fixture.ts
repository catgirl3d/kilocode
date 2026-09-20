import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import fs from "fs"
import { Session } from "../../../src/session/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionRevert } from "../../../src/session/revert"
import { SessionSummary } from "../../../src/session/summary"
import { Snapshot } from "../../../src/snapshot"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { MCP } from "../../../src/mcp"
import { LSP } from "../../../src/lsp/lsp"
import { TestLLMServer } from "../../lib/llm-server"

export type TrackEvent = { messageID?: string; hash: string; exists?: boolean }

export const events: TrackEvent[] = []
let count = 0
let watched: string | undefined

export const reset = (file?: string) => {
  count = 0
  watched = file
  events.length = 0
}

export const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

export const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionRevert.node,
  SessionSummary.node,
  Snapshot.node,
  Database.node,
  CrossSpawnSpawner.node,
  FSUtil.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

export const layer = (snapshot: Layer.Layer<Snapshot.Service> = Snapshot.defaultLayer) =>
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [Snapshot.node, snapshot],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ])

export const recording = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: (input) =>
      Effect.sync(() => {
        const hash = `hash-${++count}`
        events.push({ messageID: input?.messageID, hash, exists: watched ? fs.existsSync(watched) : undefined })
        return hash
      }),
    patch: () => Effect.succeed({ hash: "patch", files: [] }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed("diff"),
    diffFull: () => Effect.succeed([]),
    diffFile: () => Effect.succeed(undefined),
  }),
)

export const config = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: true,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})
