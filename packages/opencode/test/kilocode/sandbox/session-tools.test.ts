import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import type { Tool as AITool, ToolExecutionOptions } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import * as ToolNetwork from "@/kilocode/sandbox/network"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import type { InstanceContext } from "@/project/instance-context"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { ShellTool } from "@/tool/shell"
import * as Tool from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { QuestionTool } from "@/tool/question"
import { TodoWriteTool } from "@/tool/todo"
import { WriteTool } from "@/tool/write"
import { TestConfig } from "../../fixture/config"
import { tmpdirScoped } from "../../fixture/fixture"
import { ProviderTest } from "../../fake/provider"
import { testEffect } from "../../lib/effect"
import type { Hooks } from "@kilocode/plugin"

const projectID = ProjectV2.ID.make("sandbox-session-tools")
const sessionID = SessionID.make("ses_sandbox-session-tools")
const model = ProviderTest.model()
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}
const approvals: Permission.AskInput[] = []
const hooks: Hooks[] = []
const pluginEvents: string[] = []

function session(directory: string): Session.Info {
  return {
    id: sessionID,
    slug: "sandbox-session-tools",
    projectID,
    directory,
    title: "Sandbox worktree isolation",
    version: "test",
    permission: Permission.fromConfig({ "*": "allow" }),
    time: { created: 0, updated: 0 },
  }
}

function message(ctx: InstanceContext): MessageV2.Assistant {
  return {
    id: MessageID.make("msg_sandbox-session-tools"),
    role: "assistant",
    parentID: MessageID.make("msg_sandbox-session-tools-parent"),
    sessionID,
    mode: "build",
    agent: agent.name,
    path: { cwd: ctx.directory, root: ctx.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: 0 },
  }
}

function context(directory: string, main: string, sandboxes: string[]): InstanceContext {
  return {
    directory,
    worktree: main,
    project: {
      id: projectID,
      worktree: main,
      vcs: "git",
      time: { created: 0, updated: 0 },
      sandboxes,
    },
  }
}

const config = TestConfig.layer({
  get: () => Effect.succeed({ sandbox: { enabled: true } }),
})
const agents = Layer.mock(Agent.Service)({
  get: () => Effect.succeed(agent),
})
const sessions = Layer.mock(Session.Service)({
  get: () => Effect.succeed(session("/workspace/project/.kilo/worktrees/a")),
})
const permission = Layer.mock(Permission.Service)({
  ask: (input) =>
    Effect.sync(() => {
      approvals.push(input)
      return { manual: false } as const
    }),
})
const plugin = Layer.mock(Plugin.Service)({
  list: () => Effect.succeed(hooks),
  trigger: (name, input, output) =>
    Effect.promise(async () => {
      if (name === "tool.execute.before") {
        for (const hook of hooks)
          await hook["tool.execute.before"]?.(
            input as { tool: string; sessionID: string; callID: string },
            output as { args: Record<string, unknown> },
          )
      }
      if (name === "tool.execute.after") {
        for (const hook of hooks)
          await hook["tool.execute.after"]?.(
            input as { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
            output as { title: string; output: string; metadata: unknown },
          )
      }
      if (name === "shell.env") {
        for (const hook of hooks)
          await hook["shell.env"]?.(
            input as { cwd: string; sessionID?: string; callID?: string },
            output as { env: Record<string, string> },
          )
      }
      return output
    }),
})
const mcp = Layer.mock(MCP.Service)({
  tools: () => Effect.succeed({}),
  clients: () => Effect.succeed({}), // kilocode_change - upstream's MCP resource tools probe the clients
})
const lsp = Layer.mock(LSP.Service)({
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})
const format = Layer.mock(Format.Service)({
  file: () => Effect.succeed(false),
})
const truncate = Layer.mock(Truncate.Service)({
  output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
})
const question = Layer.mock(Question.Service)({
  ask: () => Effect.succeed([]),
})
const todo = Layer.mock(Todo.Service)({
  get: () => Effect.succeed([]),
  update: () => Effect.void,
})
const base = Layer.mergeAll(
  config,
  agents,
  sessions,
  permission,
  plugin,
  mcp,
  lsp,
  format,
  truncate,
  question,
  todo,
  Bus.layer,
  AppNodeBuilder.build(EventV2Bridge.node),
  AppNodeBuilder.build(Database.node),
  AppNodeBuilder.build(FSUtil.node),
  AppNodeBuilder.build(CrossSpawnSpawner.node),
  RuntimeFlags.layer(),
)
const registry = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const write = yield* WriteTool.pipe(Effect.flatMap(Tool.init))
    const shell = yield* ShellTool.pipe(Effect.flatMap(Tool.init))
    const ask = yield* QuestionTool.pipe(Effect.flatMap(Tool.init))
    const todos = yield* TodoWriteTool.pipe(Effect.flatMap(Tool.init))
    const list = [
      ToolNetwork.builtin(write),
      ToolNetwork.builtin(shell),
      ToolNetwork.builtin(ask),
      ToolNetwork.builtin(todos),
    ]
    return ToolRegistry.Service.of({
      ids: () => Effect.succeed(list.map((item) => item.id)),
      all: () => Effect.succeed(list),
      named: () => Effect.die(new Error("named tools are not used by this test")),
      tools: () => Effect.succeed(list),
    })
  }),
).pipe(Layer.provideMerge(base))
const it = testEffect(registry)
const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? it.live : it.live.skip

function resolve(
  ctx: InstanceContext,
  metadataCalls: { toolCallID: string; value: Record<string, any> }[] = [],
  events: string[] = pluginEvents,
) {
  return SessionTools.resolve({
    agent,
    model,
    session: session(ctx.directory),
    processor: {
      message: message(ctx),
      ensureSnapshot: () => Effect.sync(() => void events.push("snapshot")),
      // capture metadata writes so tests can assert on recorded approval provenance
      metadata: (toolCallID, value) => Effect.sync(() => void metadataCalls.push({ toolCallID, value })),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {
      cancel: () => Effect.die(new Error("cancel is not used by this test")),
      resolvePromptParts: () => Effect.die(new Error("resolvePromptParts is not used by this test")),
      prompt: () => Effect.die(new Error("prompt is not used by this test")),
    },
    memoryCache: {},
  }).pipe(Effect.provideService(InstanceRef, ctx))
}

function call(tool: AITool, input: unknown, id: string) {
  const options: ToolExecutionOptions = {
    toolCallId: id,
    messages: [],
    abortSignal: new AbortController().signal,
  }
  if (!tool.execute) return Effect.die(new Error("tool has no execute callback"))
  return Effect.tryPromise({
    try: () => Promise.resolve(tool.execute?.(input, options)),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

function exists(file: string) {
  return Effect.promise(() =>
    fs
      .access(file)
      .then(() => true)
      .catch(() => false),
  )
}

function fixture() {
  return Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const main = path.join(root, "main")
    const local = path.join(main, "packages", "app")
    const a = path.join(main, ".kilo", "worktrees", "a")
    const b = path.join(main, ".kilo", "worktrees", "b")
    const approved = path.join(root, "approved")
    yield* Effect.promise(() =>
      Promise.all([path.join(main, ".git"), local, a, b, approved].map((dir) => fs.mkdir(dir, { recursive: true }))),
    )
    yield* Effect.promise(() =>
      Promise.all(
        [
          [a, "a"],
          [b, "b"],
        ].map(async ([dir, name]) => {
          const git = path.join(main, ".git", "worktrees", name)
          await fs.mkdir(git, { recursive: true })
          await fs.writeFile(path.join(git, "commondir"), "../..\n")
          await fs.writeFile(path.join(dir, ".git"), `gitdir: ${git}\n`)
        }),
      ),
    )
    return { root, main, local, a, b, approved, ctx: context(a, main, [a, b]) }
  })
}

mac("confines model-originated file mutations to the active worktree", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const tools = yield* resolve(dirs.ctx)
    const write = tools.write
    if (!write) yield* Effect.die(new Error("write tool is missing"))

    const active = path.join(dirs.a, "active.txt")
    const sibling = path.join(dirs.b, "sibling.txt")
    const primary = path.join(dirs.main, "primary.txt")
    const outside = path.join(dirs.approved, "approved.txt")
    const outsideGit = path.join(dirs.approved, ".git", "config")
    const git = path.join(dirs.a, ".git")
    const start = approvals.length
    const stateDir = path.join(Global.Path.tmp, path.basename(dirs.root))
    const state = path.join(stateDir, "state.txt")
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(stateDir, { recursive: true, force: true })))

    const allowed = yield* call(write, { filePath: active, content: "active" }, "call-active").pipe(Effect.exit)
    const kilo = yield* call(write, { filePath: state, content: "state" }, "call-state").pipe(Effect.exit)
    const siblingResult = yield* call(write, { filePath: sibling, content: "sibling" }, "call-sibling").pipe(
      Effect.exit,
    )
    const primaryResult = yield* call(write, { filePath: primary, content: "primary" }, "call-primary").pipe(
      Effect.exit,
    )
    const outsideResult = yield* call(write, { filePath: outside, content: "approved" }, "call-approved").pipe(
      Effect.exit,
    )
    const outsideGitResult = yield* call(write, { filePath: outsideGit, content: "changed" }, "call-approved-git").pipe(
      Effect.exit,
    )
    const gitResult = yield* call(write, { filePath: git, content: "changed" }, "call-git").pipe(Effect.exit)
    const requested = approvals.slice(start)

    expect(Exit.isSuccess(allowed)).toBe(true)
    expect(Exit.isSuccess(kilo)).toBe(true)
    expect(Exit.isFailure(siblingResult)).toBe(true)
    expect(Exit.isFailure(primaryResult)).toBe(true)
    expect(Exit.isFailure(outsideResult)).toBe(true)
    expect(Exit.isFailure(outsideGitResult)).toBe(true)
    expect(Exit.isFailure(gitResult)).toBe(true)
    expect(
      requested.some(
        (request) =>
          request.permission === "external_directory" &&
          request.patterns.some((pattern) => pattern.includes(dirs.approved)),
      ),
    ).toBe(true)
    expect(yield* exists(active)).toBe(true)
    expect(yield* exists(state)).toBe(true)
    expect(yield* exists(sibling)).toBe(false)
    expect(yield* exists(primary)).toBe(false)
    expect(yield* exists(outside)).toBe(false)
    expect(yield* exists(outsideGit)).toBe(false)
    expect(yield* Effect.promise(() => fs.readFile(git, "utf8"))).toContain("gitdir:")
  }),
)

mac("keeps model-originated file mutations writable in a local checkout", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const ctx = context(dirs.local, dirs.main, [dirs.a, dirs.b])
    const tools = yield* resolve(ctx)
    const write = tools.write
    if (!write) yield* Effect.die(new Error("write tool is missing"))
    const file = path.join(dirs.main, "outside-active-directory.txt")

    const result = yield* call(write, { filePath: file, content: "local" }, "call-local").pipe(Effect.exit)

    expect(Exit.isSuccess(result)).toBe(true)
    expect(yield* exists(file)).toBe(true)
  }),
)

mac("keeps concurrent session profiles call-local", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const left = yield* resolve(context(dirs.a, dirs.main, [dirs.a, dirs.b]))
    const right = yield* resolve(context(dirs.b, dirs.main, [dirs.a, dirs.b]))
    if (!left.write || !right.write) yield* Effect.die(new Error("write tool is missing"))
    const ownA = path.join(dirs.a, "session-a.txt")
    const ownB = path.join(dirs.b, "session-b.txt")
    const escapeA = path.join(dirs.b, "from-a.txt")
    const escapeB = path.join(dirs.a, "from-b.txt")

    const result = yield* Effect.all(
      {
        ownA: call(left.write, { filePath: ownA, content: "a" }, "call-a-own").pipe(Effect.exit),
        ownB: call(right.write, { filePath: ownB, content: "b" }, "call-b-own").pipe(Effect.exit),
        escapeA: call(left.write, { filePath: escapeA, content: "a" }, "call-a-escape").pipe(Effect.exit),
        escapeB: call(right.write, { filePath: escapeB, content: "b" }, "call-b-escape").pipe(Effect.exit),
      },
      { concurrency: "unbounded" },
    )

    expect(Exit.isSuccess(result.ownA)).toBe(true)
    expect(Exit.isSuccess(result.ownB)).toBe(true)
    expect(Exit.isFailure(result.escapeA)).toBe(true)
    expect(Exit.isFailure(result.escapeB)).toBe(true)
    expect(yield* exists(ownA)).toBe(true)
    expect(yield* exists(ownB)).toBe(true)
    expect(yield* exists(escapeA)).toBe(false)
    expect(yield* exists(escapeB)).toBe(false)
  }),
)

mac("confines a model-originated sandboxed process to the active worktree", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const tools = yield* resolve(dirs.ctx)
    const shell = tools.bash
    if (!shell) yield* Effect.die(new Error("bash tool is missing"))
    const active = path.join(dirs.a, "shell-active.txt")
    const sibling = path.join(dirs.b, "shell-sibling.txt")
    const primary = path.join(dirs.main, "shell-primary.txt")
    const command = (file: string) => `printf sandbox > ${JSON.stringify(file)}`

    yield* call(shell, { command: command(active), workdir: dirs.a, description: "write active" }, "shell-active")
    yield* call(shell, { command: command(sibling), workdir: dirs.a, description: "write sibling" }, "shell-sibling")
    yield* call(shell, { command: command(primary), workdir: dirs.a, description: "write primary" }, "shell-primary")

    expect(yield* exists(active)).toBe(true)
    expect(yield* exists(sibling)).toBe(false)
    expect(yield* exists(primary)).toBe(false)
  }),
)

it.live("records why a denied tool call was refused on the tool part's metadata", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const metadataCalls: { toolCallID: string; value: Record<string, any> }[] = []
    const deniedRule = { permission: "bash", pattern: "*", action: "deny" as const, source: "project" as const }
    const overrides = Layer.mergeAll(
      TestConfig.layer({ get: () => Effect.succeed({ sandbox: { enabled: false } }) }),
      Layer.mock(Permission.Service)({
        ask: () => Effect.fail(new Permission.DeniedError({ ruleset: deniedRule })),
      }),
    )
    const tools = yield* resolve(dirs.ctx, metadataCalls).pipe(Effect.provide(overrides))
    const shell = tools.bash
    if (!shell) yield* Effect.die(new Error("bash tool is missing"))

    const result = yield* call(shell, { command: "echo hi", workdir: dirs.a }, "call-denied").pipe(Effect.exit)

    expect(Exit.isFailure(result)).toBe(true)
    const approval = metadataCalls.find((c) => c.toolCallID === "call-denied")?.value?.metadata?.approval
    expect(approval).toEqual({
      source: "project",
      rule: { permission: "bash", pattern: "*", action: "deny" },
    })
  }),
)

it.live("skips native MCP resource snapshots without hooks and protects hooks", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const events: string[] = []
    hooks.length = 0
    yield* Effect.addFinalizer(() => Effect.sync(() => void (hooks.length = 0)))
    const client = { getServerCapabilities: () => ({ resources: {} }) }
    const overrides = Layer.mergeAll(
      TestConfig.layer({ get: () => Effect.succeed({ sandbox: { enabled: false } }) }),
      Layer.mock(MCP.Service)({
        tools: () => Effect.succeed({}),
        clients: () => Effect.sync(() => (events.push("clients"), { server: client as any })),
        resources: () =>
          Effect.sync(() => {
            events.push("resources")
            return { one: { name: "one", uri: "test://one", client: "server" } }
          }),
        resourceTemplates: () =>
          Effect.sync(() => {
            events.push("resourceTemplates")
            return { one: { name: "one", uriTemplate: "test://one/{id}", client: "server" } }
          }),
        readResource: () =>
          Effect.sync(() => {
            events.push("readResource")
            return { contents: [{ uri: "test://one", text: "one" }] }
          }),
      }),
    )
    const calls = [
      { key: "list_mcp_resources", args: {}, delegate: "resources" },
      { key: "list_mcp_resource_templates", args: {}, delegate: "resourceTemplates" },
      { key: "read_mcp_resource", args: { server: "server", uri: "test://one" }, delegate: "readResource" },
    ] as const

    const plain = yield* resolve(dirs.ctx, [], events).pipe(Effect.provide(overrides))
    for (const item of calls) {
      const tool = plain[item.key]
      if (!tool) yield* Effect.die(new Error("MCP resource tool is missing"))
      events.length = 0
      yield* call(tool, item.args, "mcp-resource")
      expect(events).toEqual(["clients", item.delegate])
    }

    hooks.push({
      "tool.execute.before": async () => {
        events.push("hook")
      },
    })
    const guarded = yield* resolve(dirs.ctx, [], events).pipe(Effect.provide(overrides))
    for (const item of calls) {
      const tool = guarded[item.key]
      if (!tool) yield* Effect.die(new Error("MCP resource tool is missing"))
      events.length = 0
      yield* call(tool, item.args, "mcp-resource")
      expect(events).toEqual(["snapshot", "clients", "hook", item.delegate])
    }

    hooks.length = 0
    hooks.push({
      "tool.execute.after": async () => {
        events.push("hook")
      },
    })
    const after = yield* resolve(dirs.ctx, [], events).pipe(Effect.provide(overrides))
    for (const item of calls) {
      const tool = after[item.key]
      if (!tool) yield* Effect.die(new Error("MCP resource tool is missing"))
      events.length = 0
      yield* call(tool, item.args, "mcp-resource")
      expect(events).toEqual(["snapshot", "clients", item.delegate, "hook"])
    }
  }),
)

it.live("snapshots bash before a shell.env-only plugin hook", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    hooks.length = 0
    pluginEvents.length = 0
    hooks.push({
      "shell.env": async () => {
        pluginEvents.push("shell.env")
      },
    })
    const tools = yield* resolve(dirs.ctx).pipe(
      Effect.provide(TestConfig.layer({ get: () => Effect.succeed({ sandbox: { enabled: false } }) })),
    )
    const shell = tools.bash
    if (!shell) yield* Effect.die(new Error("bash tool is missing"))

    yield* call(shell, { command: "rg --no-config snapshot", workdir: dirs.a }, "shell-env-hook")

    expect(pluginEvents).toEqual(["snapshot", "shell.env"])
    hooks.length = 0
  }),
)

it.live("does not snapshot question and todowrite without hooks but protects their hooks", () =>
  Effect.gen(function* () {
    const dirs = yield* fixture()
    const args = {
      question: {
        questions: [{ header: "Continue", question: "Continue?", options: [], multiple: false }],
      },
      todowrite: {
        todos: [{ content: "Test todo", status: "pending", priority: "high" }],
      },
    }
    const events: string[] = []
    hooks.length = 0
    pluginEvents.length = 0
    yield* Effect.addFinalizer(() => Effect.sync(() => void (hooks.length = 0)))
    const plainLayer = TestConfig.layer({ get: () => Effect.succeed({ sandbox: { enabled: false } }) })

    const plain = yield* resolve(dirs.ctx, [], events).pipe(Effect.provide(plainLayer))
    for (const [id, input] of Object.entries(args)) {
      const tool = plain[id]
      if (!tool) yield* Effect.die(new Error(`${id} tool is missing`))
      events.length = 0
      yield* call(tool, input, `${id}-plain`)
      expect(events).toEqual([])
    }

    hooks.push({
      "tool.execute.before": async (input) => {
        events.push(`${input.tool}:hook`)
      },
    })
    const guarded = yield* resolve(dirs.ctx, [], events).pipe(Effect.provide(plainLayer))
    for (const [id, input] of Object.entries(args)) {
      const tool = guarded[id]
      if (!tool) yield* Effect.die(new Error(`${id} tool is missing`))
      events.length = 0
      yield* call(tool, input, `${id}-hooked`)
      expect(events).toEqual(["snapshot", `${id}:hook`])
    }
  }),
)
