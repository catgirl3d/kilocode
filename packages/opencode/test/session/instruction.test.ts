import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  cfg = configLayer,
) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, cfg],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const provideInstructionConfig =
  (global: Partial<Global.Interface>, cfg: Layer.Layer<Config.Service>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, cfg)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("fetches enabled remote instructions and skips disabled URLs", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()
      const enabled = "https://example.test/enabled.md"
      const disabled = "http://example.test/disabled.md"
      const requests: string[] = []
      const client = HttpClient.make((request) => {
        requests.push(request.url)
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("# Remote Enabled")))
      })
      const cfg = TestConfig.layer({
        get: () =>
          Effect.succeed({
            instructions: [enabled, disabled],
            instructions_disabled: [disabled],
          }),
      })
      const layer = AppNodeBuilder.build(Instruction.node, [
        [Config.node, cfg],
        [Global.node, Global.layerWith({ home: globalTmp, config: globalTmp })],
        [RuntimeFlags.node, RuntimeFlags.layer()],
        [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      ])

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const out = yield* svc.system()

        expect(requests).toEqual([enabled])
        expect(out).toEqual([`Instructions from: ${enabled}\n# Remote Enabled`])
        expect(out.join("\n")).not.toContain(disabled)
      }).pipe(provideInstance(projectTmp), Effect.provide(layer))
    }),
  )
})

describe("Instruction.system", () => {
  it.live("keeps global and local instruction sections separate and honors disabled entries", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectTmp = yield* tmpdirScoped()

      yield* writeFiles(globalTmp, {
        "global-enabled.md": "# Global Enabled",
        "global-disabled.md": "# Global Disabled",
      })
      yield* writeFiles(projectTmp, {
        "local-enabled.md": "# Local Enabled",
        "local-disabled.md": "# Local Disabled",
      })

      const cfg = TestConfig.layer({
        get: () =>
          Effect.succeed({
            instructions: [
              path.join(globalTmp, "global-enabled.md"),
              path.join(globalTmp, "global-disabled.md"),
              path.join(projectTmp, "local-enabled.md"),
              path.join(projectTmp, "local-disabled.md"),
            ],
            instructions_disabled: [
              path.join(globalTmp, "global-disabled.md"),
              path.join(projectTmp, "local-disabled.md"),
            ],
            instruction_origins: {
              [path.join(globalTmp, "global-enabled.md")]: {
                trusted: true,
                source: path.join(globalTmp, "kilo.json"),
              },
              [path.join(globalTmp, "global-disabled.md")]: {
                trusted: true,
                source: path.join(globalTmp, "kilo.json"),
              },
              [path.join(projectTmp, "local-enabled.md")]: {
                trusted: false,
                source: path.join(projectTmp, "kilo.json"),
                root: projectTmp,
              },
              [path.join(projectTmp, "local-disabled.md")]: {
                trusted: false,
                source: path.join(projectTmp, "kilo.json"),
                root: projectTmp,
              },
            },
          }),
      })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const out = yield* svc.system()

        expect(out).toEqual([
          `Instructions from: ${path.join(globalTmp, "global-enabled.md")}\n# Global Enabled`,
          `Instructions from: ${path.join(projectTmp, "local-enabled.md")}\n# Local Enabled`,
        ])
      }).pipe(provideInstance(projectTmp), provideInstructionConfig({ home: globalTmp, config: globalTmp }, cfg))
    }),
  )

  it.live("keeps disabled instruction state isolated per project", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpdirScoped()
      const projectA = yield* tmpdirScoped()
      const projectB = yield* tmpdirScoped()

      yield* writeFiles(globalTmp, { "global.md": "# Global" })
      yield* writeFiles(projectA, { "local.md": "# Project A" })
      yield* writeFiles(projectB, { "local.md": "# Project B" })

      const run = (dir: string, cfg: Layer.Layer<Config.Service>) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          return yield* svc.system()
        }).pipe(provideInstance(dir), provideInstructionConfig({ home: globalTmp, config: globalTmp }, cfg))

      const a = yield* run(
        projectA,
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              instructions: [path.join(globalTmp, "global.md"), path.join(projectA, "local.md")],
              instructions_disabled: [path.join(projectA, "local.md")],
              instruction_origins: {
                [path.join(globalTmp, "global.md")]: {
                  trusted: true,
                  source: path.join(globalTmp, "kilo.json"),
                },
                [path.join(projectA, "local.md")]: {
                  trusted: false,
                  source: path.join(projectA, "kilo.json"),
                  root: projectA,
                },
              },
            }),
        }),
      )
      const b = yield* run(
        projectB,
        TestConfig.layer({
          get: () =>
            Effect.succeed({
              instructions: [path.join(globalTmp, "global.md"), path.join(projectB, "local.md")],
              instruction_origins: {
                [path.join(globalTmp, "global.md")]: {
                  trusted: true,
                  source: path.join(globalTmp, "kilo.json"),
                },
                [path.join(projectB, "local.md")]: {
                  trusted: false,
                  source: path.join(projectB, "kilo.json"),
                  root: projectB,
                },
              },
            }),
        }),
      )

      expect(a).toEqual([`Instructions from: ${path.join(globalTmp, "global.md")}\n# Global`])
      expect(b).toEqual([
        `Instructions from: ${path.join(globalTmp, "global.md")}\n# Global`,
        `Instructions from: ${path.join(projectB, "local.md")}\n# Project B`,
      ])
    }),
  )

  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})
