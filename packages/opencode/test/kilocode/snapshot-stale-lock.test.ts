import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { afterEach, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Snapshot } from "../../src/snapshot"
import { Instance } from "../../src/kilocode/instance"
import { Filesystem } from "../../src/util/filesystem"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(message)
}

function run<A>(dir: string, body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const value = yield* body(snapshot)
      const gitdir = path.join(Global.Path.data, "snapshot", Instance.project.id, Hash.fast(Instance.worktree))
      return { value, gitdir }
    }).pipe(provideInstance(dir), Effect.provide(AppNodeBuilder.build(Snapshot.node)), Effect.provide(testInstanceStoreLayer)),
  )
}

async function setup(dir: string) {
  await $`git config core.autocrlf false`.cwd(dir).quiet()
  await Filesystem.write(path.join(dir, "tracked.txt"), "committed\n")
  await $`git add .`.cwd(dir).quiet()
  await $`git commit -m baseline`.cwd(dir).quiet()
}

afterEach(async () => {
  await disposeAllInstances()
})

test(
  "stale snapshot index.lock is removed instead of bricking snapshots",
  async () => {
    await using tmp = await tmpdir({
      git: true,
      init: setup,
    })
    const first = await run(tmp.path, (snapshot) => snapshot.track())
    expect(first.value).toBeTruthy()

    // Let the forked background materialization finish so it cannot race the orphan below.
    const alt = path.join(first.gitdir, "objects", "info", "alternates")
    await waitFor(async () => {
      const pending = await Promise.all(
        [alt, `${alt}.materializing`].map((file) => fs.access(file).then(() => true, () => false)),
      )
      return !pending.some(Boolean)
    }, "snapshot alternate was not removed after materialization")

    // Simulate a crashed git invocation, as seen in the field: an empty index.lock left
    // behind made every later snapshot op fail with exit code 128, forever.
    const lock = path.join(first.gitdir, "index.lock")
    await Filesystem.write(lock, "")
    await Filesystem.write(path.join(tmp.path, "tracked.txt"), "assistant\n")

    const second = await run(tmp.path, (snapshot) => snapshot.track())
    expect(second.gitdir).toBe(first.gitdir)
    expect(second.value).toBeTruthy()
    await expect(fs.access(lock)).rejects.toThrow()

    const patch = (await run(tmp.path, (snapshot) => snapshot.patch(first.value!))).value
    expect(patch.files).toContain(fwd(tmp.path, "tracked.txt"))
  },
  { timeout: 35_000 },
)

test("stale snapshot index.lock is cleaned before patching", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: setup,
  })
  const first = await run(tmp.path, (snapshot) => snapshot.track())
  expect(first.value).toBeTruthy()
  const alt = path.join(first.gitdir, "objects", "info", "alternates")
  await waitFor(async () => {
    const pending = await Promise.all(
      [alt, `${alt}.materializing`].map((file) => fs.access(file).then(() => true, () => false)),
    )
    return !pending.some(Boolean)
  }, "snapshot alternate was not removed after materialization")

  const lock = path.join(first.gitdir, "index.lock")
  await Filesystem.write(lock, "")
  await Filesystem.write(path.join(tmp.path, "tracked.txt"), "assistant edit\n")

  const patch = (await run(tmp.path, (snapshot) => snapshot.patch(first.value!))).value
  expect(patch.files).toEqual([fwd(tmp.path, "tracked.txt")])
  await expect(fs.access(lock)).rejects.toThrow()
}, { timeout: 35_000 })
