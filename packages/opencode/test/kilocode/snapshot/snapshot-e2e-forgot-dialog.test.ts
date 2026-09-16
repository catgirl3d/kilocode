import "./track-guard-e2e-env"
import { describe, expect, spyOn, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess, type RunResult } from "@opencode-ai/core/process"
import { Database } from "@opencode-ai/core/database/database"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import path from "path"
import { Config } from "../../../src/config/config"
import { GlobalBus, type GlobalEvent } from "../../../src/bus/global"
import { InstanceState } from "../../../src/effect/instance-state"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Instance } from "../../../src/kilocode/instance"
import { Question } from "../../../src/question"
import { Session } from "../../../src/session/session"
import { Snapshot } from "../../../src/snapshot"
import { KiloSnapshotTrack } from "../../../src/kilocode/snapshot/track"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        FSUtil.node,
        AppProcess.node,
        EffectFlock.node,
        Database.node,
        CrossSpawnSpawner.node,
        Config.node,
      ]),
    ),
    Snapshot.defaultLayer,
  ),
)

const isSnapshotCommand = (command: Parameters<AppProcess.Service["run"]>[0], directory: string) => {
  if (command._tag !== "StandardCommand") return false
  if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(command.command)) return false
  const gitDir = command.args.indexOf("--git-dir")
  const workTree = command.args.indexOf("--work-tree")
  return (
    (gitDir >= 0 && command.args.at(gitDir + 1) != null) ||
    (command.options?.env?.GIT_DIR != null && command.options.env.GIT_DIR !== "") ||
    (workTree >= 0 && command.args.at(workTree + 1) === directory)
  )
}

describe("Snapshot.track forgotten slow-repository dialog", () => {
  test("setup precondition: loads the E2E track and turn budgets", () => {
    expect(process.env.KILO_SNAPSHOT_TRACK_TIMEOUT_MS).toBe("2000")
    expect(process.env.KILO_SNAPSHOT_TURN_TIMEOUT_MS).toBe("3000")
    expect(KiloSnapshotTrack.TIMEOUT_MS).toBe(2_000)
    expect(KiloSnapshotTrack.TURN_TIMEOUT_MS).toBe(3_000)
  })

  it.live(
    "pauses the turn budget while the real slow-repository dialog is forgotten",
    () =>
      provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const app = yield* AppProcess.Service
            const snapshot = yield* Snapshot.Service
            yield* InstanceState.context
            const ctx = yield* InstanceRef
            const context = yield* Effect.context()
            const session = yield* Effect.promise(() =>
              AppRuntime.runPromise(
                Session.Service.use((svc) => svc.create({ title: "forgotten snapshot dialog" })).pipe(
                  Effect.provideService(InstanceRef, ctx),
                ),
              ),
            )
            yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "content"))

            const started = yield* Deferred.make<void>()
            const released = yield* Deferred.make<void>()
            const completed = yield* Deferred.make<void>()
            const opened = yield* Deferred.make<{ requestID: string }>()
            const rejected = yield* Deferred.make<string>()
            const on = (event: GlobalEvent) => {
              const payload = event.payload
              const properties = payload?.properties
              if (properties?.sessionID !== session.id) return
              if (payload.type === Question.Event.Asked.type) {
                const question = properties.questions?.at(0)
                if (question?.header !== "Snapshot is slow") return
                Deferred.doneUnsafe(opened, Effect.succeed({ requestID: properties.id }))
                return
              }
              if (payload.type === Question.Event.Rejected.type) {
                Deferred.doneUnsafe(rejected, Effect.succeed(properties.requestID))
              }
            }
            GlobalBus.on("event", on)

            const run = app.run.bind(app)
            let calls = 0
            const spy = spyOn(app, "run").mockImplementation((command, opts) => {
              if (!isSnapshotCommand(command, directory)) return run(command, opts)
              calls += 1
              if (calls !== 1) return run(command, opts)
              return Effect.gen(function* () {
                yield* Effect.sync(() => Deferred.doneUnsafe(started, Effect.succeed(undefined)))
                yield* Deferred.await(released)
                return yield* run(command, opts).pipe(
                  Effect.ensuring(Deferred.succeed(completed, undefined)),
                )
              })
            })

            // Timing: prompt 2s < nominal turn expiry 3s; release at 4s. The
            // hash can return after 4s only when the 2s dialog interval is paused.
            const releaseFiber = yield* Effect.sleep("4 seconds").pipe(
              Effect.andThen(Deferred.succeed(released, undefined)),
              Effect.forkChild,
            )
            try {
              const trackFiber = yield* Effect.sync(() =>
                Instance.restore(ctx, () =>
                  Effect.runForkWith(context)(snapshot.track({ sessionID: session.id })),
                ),
              )
              yield* awaitWithTimeout(
                Deferred.await(started),
                "the first strict-filtered snapshot Git command did not stall",
                Duration.seconds(10),
              )
              expect(calls).toBe(1)
              const question = yield* awaitWithTimeout(
                Deferred.await(opened),
                "the real slow-repository question dialog did not open",
                Duration.seconds(10),
              )
              expect(question.requestID).toBeString()
              yield* awaitWithTimeout(
                Deferred.await(completed),
                "the released snapshot Git command did not complete",
                Duration.seconds(10),
              )
              const requestID = yield* awaitWithTimeout(
                Deferred.await(rejected),
                "the real slow-repository question dialog did not auto-close",
                Duration.seconds(10),
              )
              expect(requestID).toBe(question.requestID)
              const hash = yield* awaitWithTimeout(
                Fiber.join(trackFiber),
                "the real Snapshot.track did not return after the dialog auto-closed",
                Duration.seconds(10),
              )
              expect(hash).toBeString()

              const before = calls
              const next = yield* awaitWithTimeout(
                snapshot.track({ sessionID: session.id }),
                "the subsequent Snapshot.track did not complete normally",
                Duration.seconds(10),
              )
              expect(next).toBeString()
              expect(calls).toBeGreaterThan(before)
            } finally {
              yield* Fiber.interrupt(releaseFiber)
              spy.mockRestore()
              GlobalBus.off("event", on)
              yield* Effect.promise(() =>
                AppRuntime.runPromise(
                  Session.Service.use((svc) => svc.remove(session.id)).pipe(Effect.provideService(InstanceRef, ctx)),
                ),
              )
            }
          }),
        { git: true },
      ),
    { timeout: 30_000 },
  )
})
