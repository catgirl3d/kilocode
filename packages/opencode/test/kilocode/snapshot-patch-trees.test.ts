import { test, expect } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import path from "path"
import { Snapshot } from "../../src/snapshot"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

async function bootstrap() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/a.txt`, "A")
      await Filesystem.write(`${dir}/b.txt`, "B")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit --no-gpg-sign -m init`.cwd(dir).quiet()
    },
  })
}

function run<A>(body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(Snapshot.Service.use(body).pipe(Effect.provide(Snapshot.defaultLayer)))
}

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

test(
  "tree patch lists the same files as the legacy patch",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            const before = yield* snapshot.track()
            expect(before).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED"))
            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/new.txt`, "NEW"))
            const after = yield* snapshot.track()
            expect(after).toBeTruthy()
            expect(after).not.toBe(before)

            const legacy = yield* snapshot.patch(before!)
            const tree = yield* snapshot.patch(before!, after!)
            expect([...tree.files].sort()).toEqual([...legacy.files].sort())
            expect(tree.files).toContain(fwd(tmp.path, "a.txt"))
            expect(tree.files).toContain(fwd(tmp.path, "new.txt"))
            expect(tree.hash).toBe(before!)
          }),
        ),
    })
  },
  { timeout: 35_000 },
)

test(
  "tree patch matches the legacy patch for renames",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            const before = yield* snapshot.track()
            expect(before).toBeTruthy()

            yield* Effect.promise(() => $`git mv a.txt renamed.txt`.cwd(tmp.path).quiet())
            const after = yield* snapshot.track()
            expect(after).toBeTruthy()

            const legacy = yield* snapshot.patch(before!)
            const tree = yield* snapshot.patch(before!, after!)
            expect([...tree.files].sort()).toEqual([...legacy.files].sort())
            expect(tree.files).toContain(fwd(tmp.path, "a.txt"))
            expect(tree.files).toContain(fwd(tmp.path, "renamed.txt"))
          }),
        ),
    })
  },
  { timeout: 35_000 },
)

test(
  "patch returns an empty result for equal trees without rescanning",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            const first = yield* snapshot.track()
            const second = yield* snapshot.track()
            expect(first).toBeTruthy()
            expect(second).toBe(first)

            const patch = yield* snapshot.patch(first!, second!)
            expect(patch).toEqual({ hash: first!, files: [] })
          }),
        ),
    })
  },
  { timeout: 35_000 },
)

test(
  "tree patch reflects the captured after-tree, not later worktree edits",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            const before = yield* snapshot.track()
            expect(before).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED"))
            const after = yield* snapshot.track()
            expect(after).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/external.txt`, "EXTERNAL"))
            const tree = yield* snapshot.patch(before!, after!)
            expect(tree.files).toContain(fwd(tmp.path, "a.txt"))
            expect(tree.files).not.toContain(fwd(tmp.path, "external.txt"))

            const legacy = yield* snapshot.patch(before!)
            expect(legacy.files).toContain(fwd(tmp.path, "external.txt"))
          }),
        ),
    })
  },
  { timeout: 35_000 },
)

test(
  "tree patch filters a file that became gitignored after the baseline",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/later-ignored.txt`, "initial content"))
            const before = yield* snapshot.track()
            expect(before).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/later-ignored.txt`, "modified content"))
            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/.gitignore`, "later-ignored.txt\n"))
            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/still-tracked.txt`, "new tracked file"))
            const after = yield* snapshot.track()
            expect(after).toBeTruthy()

            const tree = yield* snapshot.patch(before!, after!)
            expect(tree.files).not.toContain(fwd(tmp.path, "later-ignored.txt"))
            expect(tree.files).toContain(fwd(tmp.path, ".gitignore"))
            expect(tree.files).toContain(fwd(tmp.path, "still-tracked.txt"))
          }),
        ),
    })
  },
  { timeout: 35_000 },
)

test(
  "tree patch describes the captured trees and leaves the snapshot index untouched",
  async () => {
    await using tmp = await bootstrap()
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        run((snapshot) =>
          Effect.gen(function* () {
            const before = yield* snapshot.track()
            expect(before).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED"))
            const after = yield* snapshot.track()
            expect(after).toBeTruthy()

            yield* Effect.promise(() => Filesystem.write(`${tmp.path}/external.txt`, "EXTERNAL"))
            const refreshed = yield* snapshot.patch(before!)
            expect(refreshed.files).toContain(fwd(tmp.path, "external.txt"))

            const tree = yield* snapshot.patch(before!, after!)
            expect(tree.files).toContain(fwd(tmp.path, "a.txt"))
            expect(tree.files).not.toContain(fwd(tmp.path, "external.txt"))

            const again = yield* snapshot.patch(before!)
            expect([...again.files].sort()).toEqual([...refreshed.files].sort())
          }),
        ),
    })
  },
  { timeout: 35_000 },
)
