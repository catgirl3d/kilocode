import "./track-guard-env"
import { describe, expect, spyOn, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess, type RunResult } from "@opencode-ai/core/process"
import { ChildProcess } from "effect/unstable/process"
import { Database } from "@opencode-ai/core/database/database"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import path from "path"
import { Config } from "../../../src/config/config"
import { InstanceState } from "../../../src/effect/instance-state"
const { Snapshot } = await import("../../../src/snapshot")
const { KiloSnapshotTrack } = await import("../../../src/kilocode/snapshot/track")
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

describe("shared Snapshot service track guard", () => {
  test("setup precondition: loads the configured track and turn budgets", () => {
    expect(KiloSnapshotTrack.TIMEOUT_MS).toBe(30_000)
    expect(KiloSnapshotTrack.TURN_TIMEOUT_MS).toBe(5_000)
  })

  it.live(
    "real service applies the turn-level track guard when the inner git boundary is stalled",
    () =>
      provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const app = yield* AppProcess.Service
            const snapshot = yield* Snapshot.Service
            yield* InstanceState.context
            yield* Effect.promise(() => Bun.write(path.join(directory, "tracked.txt"), "content"))
            const started = yield* Deferred.make<void>()
            const completed = yield* Deferred.make<void>()
            const run = app.run.bind(app)
            let snapshotCalls = 0
            const spy = spyOn(app, "run").mockImplementation((command, opts) => {
              const std = ChildProcess.isStandardCommand(command) ? command : undefined
              const git = std != null && /(?:^|[\\/])git(?:\.exe)?$/i.test(std.command)
              const gitDir = std?.args.indexOf("--git-dir") ?? -1
              const workTree = std?.args.indexOf("--work-tree") ?? -1
              const snapshotCommand =
                std != null &&
                git &&
                ((gitDir >= 0 && std.args.at(gitDir + 1) != null && !std.args.at(gitDir + 1)!.startsWith("-")) ||
                  (std.options?.env?.GIT_DIR != null && std.options.env.GIT_DIR !== "") ||
                  (workTree >= 0 && std.args.at(workTree + 1) === directory) ||
                  std.args.includes("init"))
              if (!snapshotCommand) return run(command, opts)
              snapshotCalls += 1
              if (snapshotCalls !== 1) return run(command, opts)
              return Effect.gen(function* () {
                yield* Effect.sync(() => Deferred.doneUnsafe(started, Effect.succeed(undefined)))
                return yield* Effect.callback<RunResult>((_resume) => {
                  return Effect.sync(() => {
                    Deferred.doneUnsafe(completed, Effect.succeed(undefined))
                  })
                }).pipe(
                  Effect.as({
                    command: std.command,
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
              const fiber = yield* snapshot.track().pipe(Effect.forkChild)
              yield* Deferred.await(started)
              const result = yield* awaitWithTimeout(
                Fiber.join(fiber),
                "the shared Snapshot service did not apply the turn-level track guard",
                Duration.seconds(10),
              )

              expect(result).toBeUndefined()
              expect(snapshotCalls).toBe(1)

              yield* awaitWithTimeout(
                Deferred.await(completed),
                "the stalled snapshot git call was not interrupted before retry",
                Duration.seconds(10),
              )

              const beforeRetry = snapshotCalls
              yield* awaitWithTimeout(
                snapshot.track(),
                "the snapshot service did not retry after the stalled operation",
                Duration.seconds(10),
              )
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
