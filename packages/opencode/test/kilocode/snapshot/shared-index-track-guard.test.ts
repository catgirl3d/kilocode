import "./track-guard-env"
import { describe, expect, spyOn } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess, type RunResult } from "@opencode-ai/core/process"
import { Database } from "@opencode-ai/core/database/database"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { Config } from "../../../src/config/config"
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

describe("shared Snapshot service track guard", () => {
  it.live(
    "real service applies the turn-level track guard when the inner git boundary is stalled",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const app = yield* AppProcess.Service
            const snapshot = yield* Snapshot.Service
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const completed = yield* Deferred.make<void>()
            const run = app.run.bind(app)
            let calls = 0
            const spy = spyOn(app, "run").mockImplementation((command, opts) => {
              calls += 1
              if (calls !== 1) return run(command, opts)
              return Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                yield* Deferred.succeed(completed, undefined)
                return "" as unknown as RunResult
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
              expect(calls).toBe(1)
              expect(yield* snapshot.track()).toBeUndefined()
              expect(calls).toBe(1)

              yield* Deferred.succeed(release, undefined)
              yield* awaitWithTimeout(
                Deferred.await(completed),
                "the stalled snapshot git call never completed before cleanup",
                Duration.seconds(10),
              )
            } finally {
              spy.mockRestore()
              yield* Deferred.succeed(release, undefined)
            }
          }),
        { git: true },
      ),
    { timeout: 30_000 },
  )
})
