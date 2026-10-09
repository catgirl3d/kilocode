import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { normalizePath } from "../../src/agent-manager/git-import"
import {
  cleanupPool,
  createPoolManager as createManager,
  createPoolRepo as createTempRepo,
  gitExec,
  home,
  pooledSlots,
  removeDir,
  setupPool,
  slotMeta,
  waitForPooledSlot,
} from "../helpers/worktree-fixtures"

afterEach(cleanupPool)
beforeEach(setupPool)

async function clean(root: string): Promise<string> {
  return (await simpleGit(root).raw(["status", "--porcelain", "--untracked-files=all"])).trim()
}

async function waitForPooledSlots(root: string, count: number, timeout = 10000): Promise<string[]> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const slots: string[] = []
    for (const slot of await pooledSlots(root)) {
      if ((await slotMeta(slot))?.pooled === true) slots.push(slot)
    }
    if (slots.length >= count) return slots
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${count} pooled slots`)
}

describe("WorktreeManager pool warm-up", () => {
  it("warms a slot in the pool home without creating anything in the project", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)

    await manager.reconcilePool()
    manager.warmPool()
    const slot = await waitForPooledSlot(root)

    expect(await pooledSlots(root)).toEqual([slot])
    expect(normalizePath(slot).startsWith(`${normalizePath(home)}/`)).toBe(true)
    expect(existsSync(path.join(root, ".kilo"))).toBe(false)
    expect(await clean(root)).toBe("")
    expect(await manager.discoverWorktrees()).toEqual([])
  })

  it("creates no slot and no .kilo/worktrees when the pool home is unusable", async () => {
    const root = await createTempRepo()
    await fs.writeFile(home, "not a directory")
    const logs: string[] = []
    const manager = createManager(root, 1, 0, logs)

    await manager.reconcilePool()
    manager.warmPool()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(await pooledSlots(root)).toEqual([])
    expect(existsSync(path.join(root, ".kilo"))).toBe(false)
    expect(logs.some((line) => line.includes("not pre-warming worktrees"))).toBe(true)

    // Worktrees are still created on demand.
    const result = await manager.createWorktree({ branchName: "cold" })
    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", "cold"))
  })
})

describe("WorktreeManager pool claim", () => {
  it("moves an exact-match slot into .kilo/worktrees for a generated name", async () => {
    const root = await createTempRepo()
    const manager = createManager(root, 1, 0)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)

    const result = await manager.createWorktree({})

    expect(result.branch).toBe(path.basename(slot))
    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", result.branch))
    expect(existsSync(slot)).toBe(false)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(result.branch)
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
    expect(await fs.stat(path.join(result.path, ".git")).then((stat) => stat.isFile())).toBe(true)
    expect((await slotMeta(result.path))?.pooled).toBeFalsy()
    expect(await clean(root)).toBe("")

    // A replacement slot is warmed in the pool home after the claim, off the click path.
    const next = await waitForPooledSlot(root)
    expect(next).not.toBe(slot)
    expect(normalizePath(next).startsWith(`${normalizePath(home)}/`)).toBe(true)
  })

  it("delays the replacement warm-up so it does not compete with the new session", async () => {
    const root = await createTempRepo()
    const manager = createManager(root, 1, 1500)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)
    const result = await manager.createWorktree({})
    expect(result.branch).toBe(path.basename(slot))

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await pooledSlots(root)).filter((dir) => dir !== slot)).toEqual([])

    const next = await waitForPooledSlot(root, 10000)
    expect(next).not.toBe(slot)
  })

  it("moves a claimed slot to the branch-named directory for an explicit branch", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)

    const result = await manager.createWorktree({ branchName: "feature" })

    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", "feature"))
    expect(existsSync(slot)).toBe(false)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("feature")
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
  })

  it("preserves an existing branch when a delta claim collides with the slot name", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)
    const name = path.basename(slot)
    const git = simpleGit(root)

    gitExec(["git", "-C", root, "checkout", "-b", name])
    gitExec(["git", "-C", root, "commit", "--allow-empty", "-m", "preserve this commit"])
    const original = (await git.revparse(["HEAD"])).trim()
    gitExec(["git", "-C", root, "checkout", "main"])
    gitExec(["git", "-C", root, "commit", "--allow-empty", "-m", "advance base"])
    const head = (await git.revparse(["HEAD"])).trim()

    const result = await manager.createWorktree({})

    expect((await git.revparse([`refs/heads/${name}`])).trim()).toBe(original)
    expect(result.branch).not.toBe(name)
    expect((await simpleGit(result.path).revparse(["HEAD"])).trim()).toBe(head)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(result.branch)
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
  })

  it("claims a small-delta slot and yields a clean worktree at the requested commit", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)

    await fs.writeFile(path.join(root, "next.txt"), "next")
    gitExec(["git", "-C", root, "add", "."])
    gitExec(["git", "-C", root, "commit", "-m", "second"])
    const head = (await simpleGit(root).revparse(["HEAD"])).trim()

    const result = await manager.createWorktree({ branchName: "delta" })

    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", "delta"))
    expect(existsSync(slot)).toBe(false)
    expect((await simpleGit(result.path).revparse(["HEAD"])).trim()).toBe(head)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("delta")
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
  })
})

describe("WorktreeManager pool stale slot", () => {
  it("evicts a slot whose directory was deleted and cold-creates instead", async () => {
    const root = await createTempRepo()
    const logs: string[] = []
    const manager = createManager(root, 1, 0, logs)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)

    await removeDir(slot)
    expect(existsSync(slot)).toBe(false)

    const result = await manager.createWorktree({})
    expect(existsSync(result.path)).toBe(true)
    expect(result.path).not.toBe(slot)
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
    expect(logs.some((line) => line.includes("slot missing on disk, evicting"))).toBe(true)

    // The stale slot is evicted and the next create succeeds as well.
    const second = await manager.createWorktree({})
    expect(existsSync(second.path)).toBe(true)
  })

  it("reuses a healthy slot when another pooled slot was deleted", async () => {
    const root = await createTempRepo()
    const logs: string[] = []
    const manager = createManager(root, 2, 0, logs)

    manager.warmPool()
    const original = await waitForPooledSlots(root, 2)

    // The first claim consumes the pool's first slot and moves it away.
    // Identifying it pins the creation order, so the slot that stays in the
    // pool is deterministically the one claim() tries first after the
    // replacement warm.
    await manager.createWorktree({})
    const remaining = original.filter((slot) => existsSync(slot))
    expect(remaining).toHaveLength(1)
    const stale = remaining[0]!

    const refilled = await waitForPooledSlots(root, 2)
    const healthy = refilled.find((slot) => slot !== stale)
    expect(healthy).toBeDefined()

    await removeDir(stale)
    expect(existsSync(stale)).toBe(false)

    const result = await manager.createWorktree({})

    expect(result.branch).toBe(path.basename(healthy!))
    expect(existsSync(healthy!)).toBe(false)
    expect(existsSync(stale)).toBe(false)
    expect(logs.some((line) => line.includes("slot missing on disk, evicting"))).toBe(true)
  })
})
