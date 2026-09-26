// Temporary local benchmark for snapshot git chains (not committed).
// Run: bun test --timeout 600000 ./test/snapshot/bench-snapshot.ts
// Env: BENCH_RUNS, BENCH_FILES, SNAP_BENCH_OUT, SNAP_BENCH_LABEL, GIT_TRACE2_EVENT
import { afterEach } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

const RUNS = Number(process.env.BENCH_RUNS ?? "10")
const FILES = Number(process.env.BENCH_FILES ?? "300")
const OUT = process.env.SNAP_BENCH_OUT
const LABEL = process.env.SNAP_BENCH_LABEL ?? "unlabeled"

const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

type Row = {
  label: string
  run: number
  phase: string
  ms: number
  start: string
  end: string
  extra?: Record<string, unknown>
}

const rows: Row[] = []

const time = <A, E, R>(
  phase: string,
  run: number,
  fx: Effect.Effect<A, E, R>,
  extra?: (value: A) => Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const start = new Date().toISOString()
    const t0 = performance.now()
    const value = yield* fx
    const ms = performance.now() - t0
    rows.push({ label: LABEL, run, phase, ms, start, end: new Date().toISOString(), extra: extra?.(value) })
    return value
  })

const spawn = (cwd: string, cmd: string[]) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe" })
    const code = await proc.exited
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  })

const run = (dir: string, index: number) =>
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service

    // steady state: nothing changed since the previous iteration
    const before = yield* time("track_quiet_pre", index, snapshot.track())

    // edits: modify tracked, add untracked, add ignored - unique per run so every run dirties the tree
    yield* write(`${dir}/f00000.txt`, `v${index}\n`)
    yield* write(`${dir}/new-r${index}.txt`, `new ${index}\n`)
    yield* write(`${dir}/ignored.txt`, `ignored ${index}\n`)

    const after = yield* time("track_dirty", index, snapshot.track())
    if (after) {
      yield* time("patch", index, snapshot.patch(before!, after), (patch) => ({
        files: patch.files.length,
        mode: "tree",
        sameTree: before === after,
      }))
    } else {
      yield* time("patch", index, snapshot.patch(before!), (patch) => ({ files: patch.files.length, mode: "legacy" }))
    }

    // equal-tree pair: both tracks see an unchanged worktree
    const q1 = yield* time("quiet_pair_1", index, snapshot.track())
    const q2 = yield* time("quiet_pair_2", index, snapshot.track())
    if (!q1 || !q2 || q1 !== q2) {
      throw new Error(`quiet fixture broken: expected equal consecutive trees (${q1} vs ${q2})`)
    }
    yield* time("quiet_patch", index, snapshot.patch(q1, q2), (patch) => ({
      files: patch.files.length,
      mode: "tree",
      equalTrees: true,
    }))
  })

it.live(
  "benchmarks snapshot chains",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
      yield* Effect.promise(async () => {
        for (let i = 0; i < FILES; i++) await Bun.write(`${dir}/f${String(i).padStart(5, "0")}.txt`, `v0 ${i}\n`)
        await Bun.write(`${dir}/.gitignore`, "ignored.txt\n")
      })
      yield* spawn(dir, ["git", "add", "-A"])
      yield* spawn(dir, ["git", "commit", "-m", "fixture"])

      yield* Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        // warm-up: seed + materialize once, outside the measured runs
        yield* snapshot.track()
        yield* Effect.sleep("4 seconds")
        for (let index = 1; index <= RUNS; index++) {
          yield* run(dir, index)
        }
      }).pipe(provideInstance(dir))

      const phases = Array.from(new Set(rows.map((row) => row.phase)))
      const summary = phases.map((phase) => {
        const times = rows
          .filter((row) => row.phase === phase)
          .map((row) => row.ms)
          .sort((a, b) => a - b)
        const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * (times.length - 1)))]
        return {
          phase,
          n: times.length,
          p50: Number(at(0.5).toFixed(1)),
          p95: Number(at(0.95).toFixed(1)),
          min: Number(times[0]!.toFixed(1)),
          max: Number(times.at(-1)!.toFixed(1)),
          avg: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
        }
      })
      if (OUT) fs.writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
      console.log(`BENCH_LABEL=${LABEL} runs=${RUNS} files=${FILES}`)
      console.log(JSON.stringify(summary, null, 0))
      console.log(
        "EXTRA " +
          JSON.stringify({
            patchFiles: rows.filter((r) => r.phase === "patch").map((r) => r.extra?.files),
            patchMode: rows.filter((r) => r.phase === "patch").map((r) => r.extra?.mode),
            quietPatchFiles: rows.filter((r) => r.phase === "quiet_patch").map((r) => r.extra?.files),
          }),
      )
    }),
  { timeout: 600_000 },
)
