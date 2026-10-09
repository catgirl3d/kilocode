import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import os from "node:os"
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
  metaFile,
  pooledSlots,
  setupPool,
  waitForPooledSlot,
  tempDirs,
} from "../helpers/worktree-fixtures"

afterEach(cleanupPool)
beforeEach(setupPool)

async function legacySlot(root: string): Promise<string> {
  const slot = path.join(root, ".kilo", "worktrees", "legacy-slot")
  gitExec(["git", "-C", root, "worktree", "add", "--detach", slot, "HEAD"])
  await fs.writeFile(metaFile(slot), JSON.stringify({ pooled: true, owner: 999999, baseRef: "main" }))
  return slot
}

describe("WorktreeManager pool reconcile", () => {
  it("trusts the slot HEAD over stale metadata when adopting", async () => {
    const root = await createTempRepo()
    createManager(root).warmPool()
    const slot = await waitForPooledSlot(root)
    const head = (await simpleGit(slot).revparse(["HEAD"])).trim()

    // Simulate a crash between a retarget checkout and its metadata write.
    const pointer = await fs.readFile(path.join(slot, ".git"), "utf-8")
    const dir = path.resolve(slot, pointer.match(/^gitdir:\s*(.+)$/m)![1]!.trim())
    const file = path.join(dir, "kilo-agent-manager-metadata.json")
    const meta = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>
    await fs.writeFile(file, JSON.stringify({ ...meta, owner: 999999, baseOid: "0".repeat(40) }))

    const manager = createManager(root)
    await manager.reconcilePool()
    const result = await manager.createWorktree({})

    expect(result.branch).toBe(path.basename(slot))
    expect((await simpleGit(result.path).revparse(["HEAD"])).trim()).toBe(head)
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
  })
})

describe("WorktreeManager pool disabled", () => {
  it("keeps creation behavior unchanged when poolSize is 0", async () => {
    const root = await createTempRepo()
    const manager = createManager(root, 0)

    manager.warmPool()
    expect(await pooledSlots(root)).toEqual([])

    const result = await manager.createWorktree({ branchName: "plain" })

    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", "plain"))
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("plain")
  })

  it("does not create the worktrees directory when reconciling with poolSize 0", async () => {
    const root = await createTempRepo()
    const manager = createManager(root, 0)

    await manager.reconcilePool()

    expect(existsSync(path.join(root, ".kilo", "worktrees"))).toBe(false)
  })

  it("still removes leftover pooled slots when reconciling with poolSize 0", async () => {
    const root = await createTempRepo()
    createManager(root).warmPool()
    const slot = await waitForPooledSlot(root)

    await createManager(root, 0).reconcilePool()

    expect(existsSync(slot)).toBe(false)
    expect(await pooledSlots(root)).toEqual([])
  })
})

describe("WorktreeManager pool home", () => {
  it("discards a slot that cannot be moved and creates the worktree normally", async () => {
    const root = await createTempRepo()
    const logs: string[] = []
    const manager = createManager(root, 1, 60_000, logs)

    manager.warmPool()
    const slot = await waitForPooledSlot(root)
    const name = path.basename(slot)
    const blocked = path.join(root, ".kilo", "worktrees", name)
    await fs.mkdir(blocked, { recursive: true })

    const result = await manager.createWorktree({})

    expect(result.path).toBe(path.join(root, ".kilo", "worktrees", result.branch))
    expect(result.branch).not.toBe(name)
    expect(existsSync(slot)).toBe(false)
    expect(await pooledSlots(root)).toEqual([])
    expect(await simpleGit(root).raw(["branch", "--list", name])).toBe("")
    expect((await simpleGit(result.path).raw(["status", "--porcelain"])).trim()).toBe("")
    expect(logs.some((line) => line.includes("discarding"))).toBe(true)
  })

  it("removes slots an older version left in .kilo/worktrees", async () => {
    const root = await createTempRepo()
    const legacy = await legacySlot(root)

    const manager = createManager(root)
    await manager.reconcilePool()

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(path.join(root, ".kilo"))).toBe(false)
    expect(await pooledSlots(root)).toEqual([])

    manager.warmPool()
    expect(normalizePath(await waitForPooledSlot(root)).startsWith(`${normalizePath(home)}/`)).toBe(true)
    expect(existsSync(path.join(root, ".kilo"))).toBe(false)
  })

  it("keeps a session worktree whose pooled metadata was never cleared", async () => {
    const root = await createTempRepo()
    const manager = createManager(root, 1, 60_000)
    manager.warmPool()
    await waitForPooledSlot(root)
    const result = await manager.createWorktree({})
    await fs.writeFile(path.join(result.path, "work.txt"), "uncommitted")
    // Simulate a claim that stopped before it cleared the slot metadata.
    await fs.writeFile(metaFile(result.path), JSON.stringify({ pooled: true, owner: 999999 }))

    await createManager(root).reconcilePool()
    await createManager(root, 0).reconcilePool()

    expect(await fs.readFile(path.join(result.path, "work.txt"), "utf-8")).toBe("uncommitted")
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(result.branch)
  })

  it("removes pool home slots when the pool is disabled", async () => {
    const root = await createTempRepo()
    createManager(root).warmPool()
    const slot = await waitForPooledSlot(root)

    await createManager(root, 0).reconcilePool()

    expect(existsSync(slot)).toBe(false)
    expect(await pooledSlots(root)).toEqual([])
    expect(existsSync(path.join(root, ".kilo"))).toBe(false)
  })
})

describe("WorktreeManager commit detection", () => {
  it("reports an empty repository through the commit check", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-pool-empty-"))
    tempDirs.push(root)
    gitExec(["git", "init", "-b", "main", root])

    await expect(createManager(root).defaultBranch()).rejects.toThrow(
      "This repository has no commits yet. Create an initial commit before using worktrees.",
    )
  })
})
