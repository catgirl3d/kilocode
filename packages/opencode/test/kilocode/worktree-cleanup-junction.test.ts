import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { WorktreeCleanup } from "../../src/kilocode/worktree-cleanup"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kilo-cleanup-")))
  dirs.push(dir)
  return dir
}

/** The same shape `Worktree.remove` hands in: a real git, so the removal really runs. */
function runner(calls: string[][] = []) {
  return (args: string[], opts?: { cwd?: string }) =>
    Effect.promise(async () => {
      calls.push(args)
      const res = await $`git ${args}`
        .cwd(opts?.cwd ?? process.cwd())
        .quiet()
        .nothrow()
      return { code: res.exitCode, text: res.stdout.toString(), stderr: res.stderr.toString() }
    })
}

async function repo(): Promise<{ root: string; wt: string }> {
  const root = await temp()
  await $`git init -q -b main`.cwd(root).quiet()
  await $`git config user.email t@example.invalid`.cwd(root).quiet()
  await $`git config user.name t`.cwd(root).quiet()
  await Bun.write(path.join(root, "a.txt"), "a")
  await $`git add .`.cwd(root).quiet()
  await $`git commit -q -m init`.cwd(root).quiet()
  const wt = path.join(await temp(), "wt")
  await $`git worktree add -q -b junction ${wt}`.cwd(root).quiet()
  return { root, wt }
}

describe("WorktreeCleanup.remove", () => {
  test.skipIf(process.platform !== "win32")("does not let git empty the target of a junction", async () => {
    const { root, wt } = await repo()
    const outside = await temp()
    await fs.mkdir(path.join(outside, "deep"))
    await Bun.write(path.join(outside, "MARKER"), "x")
    await Bun.write(path.join(outside, "deep", "MARKER"), "x")
    await fs.symlink(outside, path.join(wt, "linked"), "junction")

    const result = await Effect.runPromise(
      WorktreeCleanup.remove({ root, target: wt, git: runner(), stop: () => Effect.void }),
    )

    expect(result.code).toBe(0)
    expect(await Bun.file(path.join(outside, "MARKER")).exists()).toBe(true)
    expect(await Bun.file(path.join(outside, "deep", "MARKER")).exists()).toBe(true)
    expect(await $`git worktree list --porcelain`.cwd(root).quiet().text()).not.toContain(wt.replaceAll("\\", "/"))
  })

  test.skipIf(process.platform !== "win32")("refuses to run git when a directory cannot be searched", async () => {
    const { root } = await repo()
    const file = path.join(await temp(), "not-a-directory")
    await Bun.write(file, "x")
    const calls: string[][] = []

    const result = await Effect.runPromise(
      WorktreeCleanup.remove({ root, target: file, git: runner(calls), stop: () => Effect.void }),
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("refusing a forced git removal")
    expect(calls).toEqual([])
  })
})
