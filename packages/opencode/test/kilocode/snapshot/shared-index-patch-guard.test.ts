import "./track-guard-env"
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
import { InstanceState } from "../../../src/effect/instance-state"
import { KiloSnapshotTrack } from "../../../src/kilocode/snapshot/track"
import { Snapshot } from "../../../src/snapshot"
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

const isSnapshotCommand = (command: Parameters<AppProcess.Service["run"]>[0], directory: string) =>
  command._tag === "StandardCommand" &&
  /(?:^|[\\/])git(?:\.exe)?$/i.test(command.command) &&
  (command.args.some((arg, index) => arg === "--git-dir" && command.args.at(index + 1) != null) ||
    (command.options?.env?.GIT_DIR != null && command.options.env.GIT_DIR !== "") ||
    command.args.some((arg, index) => arg === "--work-tree" && command.args.at(index + 1) === directory))

describe("shared Snapshot service patch guard", () => {
  test("setup precondition: loads both configured budgets before constructing the public service", () => {
    expect(KiloSnapshotTrack.TIMEOUT_MS).toBe(30_000)
    expect(KiloSnapshotTrack.TURN_TIMEOUT_MS).toBe(5_000)
  })

  it.live(
    "returns the patch fallback after interruption and permits a later real patch",
    () =>
      provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const app = yield* AppProcess.Service
            const snapshot = yield* Snapshot.Service
            yield* InstanceState.context
            yield* Effect.promise(() => Bun.write(path.join(directory, "patched.txt"), "content"))
            const hash = yield* snapshot.track()
            expect(hash).toBeString()
            if (!hash) return

            const started = yield* Deferred.make<void>()
            const interrupted = yield* Deferred.make<void>()
            const secondStarted = yield* Deferred.make<void>()
            const run = app.run.bind(app)
            let snapshotCalls = 0
            let stalled = false
            const spy = spyOn(app, "run").mockImplementation((command, opts) => {
              const isSnapshotDiffFiles = isSnapshotCommand(command, directory) && command.args.includes("diff-files")
              if (!isSnapshotDiffFiles) return run(command, opts)
              snapshotCalls += 1
              if (stalled) {
                return Effect.gen(function* () {
                  yield* Effect.sync(() => Deferred.doneUnsafe(secondStarted, Effect.succeed(undefined)))
                  return yield* run(command, opts)
                })
              }
              stalled = true
              return Effect.gen(function* () {
                yield* Effect.sync(() => Deferred.doneUnsafe(started, Effect.succeed(undefined)))
                return yield* Effect.never.pipe(
                  Effect.ensuring(Deferred.succeed(interrupted, undefined)),
                  Effect.as({
                    command: command.command,
                    exitCode: 0,
                    stdout: Buffer.from(""),
                    stderr: Buffer.from(""),
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  } satisfies RunResult),
                )
              })
            })

            try {
              const first = yield* snapshot.patch(hash).pipe(Effect.forkChild)
              yield* Deferred.await(started)
              const result = yield* awaitWithTimeout(
                Fiber.join(first),
                "the public Snapshot.patch service did not apply its turn guard",
                Duration.seconds(10),
              )
              expect(result).toEqual({ hash, files: [] })
              yield* awaitWithTimeout(
                Deferred.await(interrupted),
                "the stalled patch Git call was not interrupted",
                Duration.seconds(10),
              )

              const beforeRetry = snapshotCalls
              const retry = yield* snapshot.patch(hash).pipe(Effect.forkChild)
              yield* awaitWithTimeout(
                Deferred.await(secondStarted),
                "the later public Snapshot.patch call did not reach Git",
                Duration.seconds(10),
              )
              expect(yield* Fiber.join(retry)).toEqual({ hash, files: [] })
              expect(snapshotCalls).toBeGreaterThan(beforeRetry)
            } finally {
              spy.mockRestore()
            }
          }),
        { git: true },
      ),
    { timeout: 30_000 },
  )
})
