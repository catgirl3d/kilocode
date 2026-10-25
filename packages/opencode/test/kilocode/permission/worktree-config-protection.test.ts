import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../../src/bus"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../../src/session/schema"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const bus = Bus.layer
const env = Layer.mergeAll(AppNodeBuilder.build(Permission.node), bus, AppNodeBuilder.build(CrossSpawnSpawner.node))
const it = testEffect(env)

const ask = (input: Permission.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Permission.ReplyInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const saveAlwaysRules = (input: Parameters<Permission.Interface["saveAlwaysRules"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.saveAlwaysRules(input)
  })

const allow = (input: Parameters<Permission.Interface["allowEverything"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.allowEverything(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const rejectAll = () =>
  Effect.gen(function* () {
    for (const req of yield* list()) {
      yield* reply({ requestID: req.id, reply: "reject" })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 500 })) {
      const items = yield* list()
      if (items.length === count) return items
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const immediate = <A, E, R>(pending: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* pending.pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) {
      yield* rejectAll()
      return yield* exit
    }
    expect(yield* list()).toHaveLength(0)
  })

const withDir = <A, E, R>(self: (dir: string) => Effect.Effect<A, E, R>) => provideTmpdirInstance(self, { git: true })

const withConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
  )

const autoApprove = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* allow({ enable: true, runtime: true })
    return yield* effect
  }).pipe(Effect.ensuring(allow({ enable: false, runtime: true })))

const edit = (id: string, pattern: string, filepath: string): Permission.AskInput => ({
  id: PermissionV1.ID.make(id),
  sessionID: SessionID.make("session_worktree_protection"),
  permission: "edit",
  patterns: [pattern],
  metadata: { filepath },
  always: ["*"],
  ruleset: [],
})

describe("managed worktree edit permissions", () => {
  it.live("auto-approve edits a worktree source file without prompting", () =>
    withDir((dir) =>
      autoApprove(
        immediate(
          ask(
            edit(
              "permission_worktree_source",
              ".kilo/worktrees/remove-default-server/client/src/stores/modeStatus.ts",
              path.join(dir, ".kilo", "worktrees", "remove-default-server", "client", "src", "stores", "modeStatus.ts"),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("auto-approve still asks for a root config file inside a worktree", () =>
    withDir((dir) =>
      autoApprove(
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_worktree_config")
          const pending = yield* ask(
            edit(
              "permission_worktree_config",
              ".kilo/worktrees/feature/kilo.json",
              path.join(dir, ".kilo", "worktrees", "feature", "kilo.json"),
            ),
          ).pipe(Effect.forkScoped)

          const items = yield* waitForPending(1)
          expect(items[0]).toMatchObject({
            id,
            permission: "edit",
            metadata: { disableAlways: true, configProtected: true },
          })

          yield* rejectAll()
          yield* Fiber.await(pending)
        }),
      ),
    ),
  )

  it.live("auto-approve still asks for config directories inside a worktree", () =>
    withDir((dir) =>
      autoApprove(
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_worktree_command")
          const pending = yield* ask(
            edit(
              "permission_worktree_command",
              ".kilo/worktrees/feature/.kilo/command/deploy.md",
              path.join(dir, ".kilo", "worktrees", "feature", ".kilo", "command", "deploy.md"),
            ),
          ).pipe(Effect.forkScoped)

          const items = yield* waitForPending(1)
          expect(items[0]).toMatchObject({
            id,
            metadata: { disableAlways: true, configProtected: true },
          })

          yield* rejectAll()
          yield* Fiber.await(pending)
        }),
      ),
    ),
  )

  it.live("enabling auto-approve does not resolve a pending worktree config request", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const pending = yield* ask(
          edit(
            "permission_worktree_pending",
            ".kilo/worktrees/feature/kilo.json",
            path.join(dir, ".kilo", "worktrees", "feature", "kilo.json"),
          ),
        ).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* allow({ enable: true, runtime: true })
        expect(yield* waitForPending(1)).toHaveLength(1)

        yield* rejectAll()
        yield* Fiber.await(pending)
      }).pipe(Effect.ensuring(allow({ enable: false, runtime: true }))),
    ),
  )

  it.live("protected worktree config never persists an always rule", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const config = yield* tmpdirScoped()
        yield* withConfigDir(
          config,
          Effect.gen(function* () {
            const id = PermissionV1.ID.make("permission_worktree_always")
            const pending = yield* ask(
              edit(
                "permission_worktree_always",
                ".kilo/worktrees/feature/kilo.json",
                path.join(dir, ".kilo", "worktrees", "feature", "kilo.json"),
              ),
            ).pipe(Effect.forkScoped)

            yield* waitForPending(1)
            yield* saveAlwaysRules({ requestID: id, approvedAlways: ["*"] })
            yield* reply({ requestID: id, reply: "always" })
            yield* Fiber.await(pending)

            expect(existsSync(path.join(config, "kilo.jsonc"))).toBe(false)
            expect(existsSync(path.join(config, "kilo.json"))).toBe(false)
          }),
        )
      }),
    ),
  )

  it.live("hard deny still rejects a worktree source edit", () =>
    withDir((dir) =>
      autoApprove(
        Effect.gen(function* () {
          const exit = yield* ask({
            ...edit(
              "permission_worktree_denied",
              ".kilo/worktrees/feature/src/index.ts",
              path.join(dir, ".kilo", "worktrees", "feature", "src", "index.ts"),
            ),
            hardRuleset: [{ permission: "edit", pattern: "*", action: "deny" } as const],
          }).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.DeniedError)
        }),
      ),
    ),
  )
})
