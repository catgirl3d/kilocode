import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Cause, Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "../../../src/bus"
import * as Config from "../../../src/config/config"
import { AllowEverythingPermission } from "../../../src/kilocode/permission/allow-everything"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { provideTestInstance } from "../../fixture/fixture"
import { Server } from "../../../src/server/server"
import { Session } from "../../../src/session/session"
import {
  provideInstance,
  provideTmpdirInstance,
  testInstanceStoreLayer,
  tmpdir,
  tmpdirScoped,
} from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Permission.node,
    Config.node,
    Session.node,
    SessionProjector.node,
    Bus.node,
    CrossSpawnSpawner.node,
  ]),
)
const it = testEffect(env)
const original = {
  password: Flag.KILO_SERVER_PASSWORD,
  username: Flag.KILO_SERVER_USERNAME,
  envPassword: process.env.KILO_SERVER_PASSWORD,
  envUsername: process.env.KILO_SERVER_USERNAME,
}

afterEach(() => {
  Flag.KILO_SERVER_PASSWORD = original.password
  Flag.KILO_SERVER_USERNAME = original.username
  if (original.envPassword === undefined) delete process.env.KILO_SERVER_PASSWORD
  else process.env.KILO_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.KILO_SERVER_USERNAME
  else process.env.KILO_SERVER_USERNAME = original.envUsername
})

const auth = () => `Basic ${Buffer.from("kilo:secret").toString("base64")}`

const requireAuth = () => {
  Flag.KILO_SERVER_PASSWORD = "secret"
  Flag.KILO_SERVER_USERNAME = undefined
  process.env.KILO_SERVER_PASSWORD = "secret"
  delete process.env.KILO_SERVER_USERNAME
}

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

const wait = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      if ((yield* permission.list()).length > 0) return
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error("timed out waiting for pending permission request"))
  })

describe("AllowEverythingPermission", () => {
  test("handles disable requests through the HTTP endpoint", async () => {
    requireAuth()
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const blocked = await Server.Default().app.request("/permission/allow-everything", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kilo-directory": tmp.path },
          body: JSON.stringify({ enable: true }),
        })
        expect(blocked.status).toBe(401)

        const enable = await Server.Default().app.request("/permission/allow-everything", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kilo-directory": tmp.path, authorization: auth() },
          body: JSON.stringify({ enable: true }),
        })
        expect(enable.status).toBe(200)

        const disable = await Server.Default().app.request("/permission/allow-everything", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kilo-directory": tmp.path, authorization: auth() },
          body: JSON.stringify({ enable: false }),
        })
        expect(disable.status).toBe(200)
        expect(await disable.json()).toBe(true)
      },
    })
  }, { timeout: 15_000 })

  it.live("disables global allow-all and restores permission prompts", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          expect(yield* AllowEverythingPermission.effect({ enable: true })).toBe(true)
          expect(yield* AllowEverythingPermission.effect({ enable: false })).toBe(true)

          const session = yield* sessions.create({})
          const pending = yield* ask({
            id: PermissionV1.ID.make("permission_global_disable"),
            sessionID: session.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          }).pipe(Effect.forkScoped)

          yield* wait()
          yield* reply({
            requestID: PermissionV1.ID.make("permission_global_disable"),
            reply: "reject",
          })

          const exit = yield* Fiber.await(pending)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
          }
        }),
      { git: true },
    ),
  )

  it.live(
    "runtime allow-all drains pending requests without persisting a global rule",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const cfg = yield* Config.Service
            const before = (yield* cfg.getGlobal()).permission
            const session = yield* sessions.create({})
            const pending = yield* ask({
              id: PermissionV1.ID.make("permission_runtime_pending"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["npm run typecheck"],
              metadata: {},
              always: [],
              ruleset: [],
            }).pipe(Effect.forkScoped)

            yield* wait()
            expect(yield* AllowEverythingPermission.effect({ enable: true, runtime: true })).toBe(true)
            expect(yield* Fiber.await(pending)).toMatchObject({ _tag: "Success" })
            expect((yield* cfg.getGlobal()).permission).toEqual(before)

            const denied = yield* ask({
              id: PermissionV1.ID.make("permission_runtime_hard_deny"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["rm -rf /"],
              metadata: {},
              always: [],
              ruleset: [],
              hardRuleset: [{ permission: "bash", pattern: "rm -rf /", action: "deny" }],
            }).pipe(Effect.exit)
            expect(Exit.isFailure(denied)).toBe(true)

            const configured = yield* ask({
              id: PermissionV1.ID.make("permission_runtime_config_deny"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["rm -rf /"],
              metadata: {},
              always: [],
              ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
            }).pipe(Effect.exit)
            expect(Exit.isFailure(configured)).toBe(true)

            expect(yield* AllowEverythingPermission.effect({ enable: false, runtime: true })).toBe(true)
            const next = yield* ask({
              id: PermissionV1.ID.make("permission_runtime_disabled"),
              sessionID: session.id,
              permission: "bash",
              patterns: ["npm run typecheck"],
              metadata: {},
              always: [],
              ruleset: [],
            }).pipe(Effect.forkScoped)
            yield* wait()
            yield* reply({ requestID: PermissionV1.ID.make("permission_runtime_disabled"), reply: "reject" })
            expect(Exit.isFailure(yield* Fiber.await(next))).toBe(true)
          }),
        { git: true },
      ),
    { timeout: 15_000 },
  )

  it.live("runtime allow-all applies to directories opened after it is enabled", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped({ git: true })

      yield* AllowEverythingPermission.effect({ enable: true, runtime: true }).pipe(provideInstance(first))
      const result = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        return yield* ask({
          id: PermissionV1.ID.make("permission_runtime_late_directory"),
          sessionID: session.id,
          permission: "bash",
          patterns: ["npm run typecheck"],
          metadata: {},
          always: [],
          ruleset: [],
        })
      }).pipe(provideInstance(second))

      expect(result).toEqual({
        manual: false,
        rule: { permission: "*", pattern: "*", action: "allow" },
      })
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.live("disables session-scoped allow-all without affecting other sessions", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          expect(yield* AllowEverythingPermission.effect({ enable: true, sessionID: session.id })).toBe(true)
          expect(yield* AllowEverythingPermission.effect({ enable: false, sessionID: session.id })).toBe(true)

          const next = yield* sessions.get(session.id)
          expect(next.permission ?? []).toEqual([])

          const pending = yield* ask({
            id: PermissionV1.ID.make("permission_session_disable"),
            sessionID: session.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          }).pipe(Effect.forkScoped)

          yield* wait()
          yield* reply({
            requestID: PermissionV1.ID.make("permission_session_disable"),
            reply: "reject",
          })

          const exit = yield* Fiber.await(pending)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
          }

          const other = yield* sessions.create({})
          const blocked = yield* ask({
            id: PermissionV1.ID.make("permission_other_session"),
            sessionID: other.id,
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
            ruleset: [],
          }).pipe(Effect.forkScoped)

          yield* wait()
          yield* reply({
            requestID: PermissionV1.ID.make("permission_other_session"),
            reply: "reject",
          })

          const blockedExit = yield* Fiber.await(blocked)
          expect(Exit.isFailure(blockedExit)).toBe(true)
          if (Exit.isFailure(blockedExit)) {
            expect(Cause.squash(blockedExit.cause)).toBeInstanceOf(Permission.RejectedError)
          }
        }),
      { git: true },
    ),
  )
})
