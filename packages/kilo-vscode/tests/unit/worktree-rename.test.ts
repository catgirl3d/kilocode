import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { WorktreeRollbackError } from "../../src/agent-manager/WorktreeManager"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { cleanup, createManager, createTempRepo, tempDirs } from "../helpers/worktree-fixtures"

afterEach(cleanup)

describe("WorktreeManager.renameWorktree", () => {
  it("renames the branch and directory while keeping the checkout usable", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")

    const result = await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    const git = simpleGit(result.path)
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")

    expect(result).toEqual({
      branch: "fix-token-refresh",
      path: path.join(root, ".kilo", "worktrees", "fix-token-refresh"),
    })
    expect(path.basename(result.path)).toBe(result.branch)
    expect(existsSync(created.path)).toBe(false)
    expect(existsSync(result.path)).toBe(true)
    expect(await fs.readFile(file.replace(created.path, result.path), "utf-8")).toBe("keep me")
    await git.raw(["status"])
    expect((await git.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(result.branch)
    expect(listed).toContain(result.path.replaceAll("\\", "/"))

    await fs.writeFile(path.join(result.path, "committed.txt"), "usable")
    await git.add("committed.txt")
    await git.commit("verify renamed worktree")
    expect((await git.log(["-1"])).latest?.message).toBe("verify renamed worktree")
  }, 30_000)

  it("restores the source after native move verification fails twice", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const file = path.join(created.path, "draft.txt")
    const target = path.join(root, ".kilo", "worktrees", "fix-token-refresh")
    await fs.writeFile(file, "keep me")

    const state = new WorktreeStateManager(root, () => undefined)
    const row = state.addWorktree({
      branch: created.branch,
      path: created.path,
      parentBranch: "main",
      branchOwned: true,
    })
    await state.flush()

    const internal = manager as unknown as {
      verifyMovedWorktree: (oldPath: string, newPath: string, branch: string) => Promise<void>
    }
    const verify = internal.verifyMovedWorktree
    let faults = 0
    internal.verifyMovedWorktree = async () => {
      faults++
      throw new Error(`verification fault ${faults}`)
    }

    let failure: unknown
    try {
      await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    } catch (error) {
      failure = error
    } finally {
      internal.verifyMovedWorktree = verify
    }

    expect(failure).toBeInstanceOf(Error)
    expect(faults).toBe(2)
    expect(existsSync(created.path)).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fs.readFile(file, "utf-8")).toBe("keep me")

    const git = simpleGit(created.path)
    await git.raw(["status"])
    expect((await git.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(created.branch)
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).toContain(`worktree ${created.path.replaceAll("\\", "/")}`)
    expect(listed).not.toContain(`worktree ${target.replaceAll("\\", "/")}`)
    expect((await simpleGit(root).branch()).all).toContain(created.branch)
    expect((await simpleGit(root).branch()).all).not.toContain("fix-token-refresh")

    const reloaded = new WorktreeStateManager(root, () => undefined)
    await reloaded.load()
    expect(reloaded.getWorktree(row.id)).toMatchObject({ branch: created.branch, path: created.path })
  }, 30_000)

  it("uses filesystem rename and repair when native worktree move is refused", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const target = path.join(root, ".kilo", "worktrees", "fix-token-refresh")
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")

    const git = (manager as unknown as { git: { raw: (args: string[]) => Promise<string> } }).git
    const raw = git.raw.bind(git)
    const calls: string[][] = []
    git.raw = async (args) => {
      calls.push([...args])
      if (args[0] === "worktree" && args[1] === "move") throw new Error("native move refused")
      return raw(args)
    }

    let result: { branch: string; path: string } | undefined
    try {
      result = await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    } finally {
      git.raw = raw
    }

    expect(result).toEqual({ branch: "fix-token-refresh", path: target })
    expect(existsSync(created.path)).toBe(false)
    expect(existsSync(target)).toBe(true)
    expect(await fs.readFile(path.join(target, "draft.txt"), "utf-8")).toBe("keep me")
    expect(calls.some((args) => args[0] === "worktree" && args[1] === "repair" && args.includes(target))).toBe(true)
    const checkout = simpleGit(target)
    await checkout.raw(["status"])
    expect((await checkout.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe("fix-token-refresh")
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).not.toContain(`worktree ${created.path.replaceAll("\\", "/")}`)
    expect(listed).toContain(`worktree ${target.replaceAll("\\", "/")}`)
  }, 30_000)

  it("rolls back the branch when physical fallback move fails before moving", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const target = path.join(root, ".kilo", "worktrees", "fix-token-refresh")
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")

    const git = (manager as unknown as { git: { raw: (args: string[]) => Promise<string> } }).git
    const raw = git.raw.bind(git)
    git.raw = async (args) => {
      if (args[0] === "worktree" && args[1] === "move") throw new Error("native move refused")
      return raw(args)
    }
    const realRename = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === created.path && String(to) === target) throw new Error("physical move refused")
      return realRename(from, to)
    })

    let failure: unknown
    try {
      await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    } catch (error) {
      failure = error
    } finally {
      rename.mockRestore()
      git.raw = raw
    }

    expect(failure).toBeInstanceOf(Error)
    expect(existsSync(created.path)).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fs.readFile(file, "utf-8")).toBe("keep me")
    const checkout = simpleGit(created.path)
    await checkout.raw(["status"])
    expect((await checkout.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(created.branch)
    expect((await simpleGit(root).branch()).all).not.toContain("fix-token-refresh")
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).toContain(`worktree ${created.path.replaceAll("\\", "/")}`)
    expect(listed).not.toContain(`worktree ${target.replaceAll("\\", "/")}`)
  }, 30_000)

  it("reports a typed fatal error when physical restore is refused", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const target = path.join(root, ".kilo", "worktrees", "fix-token-refresh")
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")

    const internal = manager as unknown as {
      verifyMovedWorktree: (oldPath: string, newPath: string, branch: string) => Promise<void>
    }
    const verify = internal.verifyMovedWorktree
    internal.verifyMovedWorktree = async () => {
      throw new Error("verification fault")
    }
    const realRename = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === target && String(to) === created.path) throw new Error("restore refused")
      return realRename(from, to)
    })

    let failure: unknown
    try {
      await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    } catch (error) {
      failure = error
    } finally {
      rename.mockRestore()
      internal.verifyMovedWorktree = verify
    }

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toBeInstanceOf(WorktreeRollbackError)
    expect((failure as Error).message).toContain(created.path)
    expect((failure as Error).message).toContain(target)
    expect(failure).toMatchObject({ source: created.path, target, branch: "fix-token-refresh" })
    expect(existsSync(created.path)).toBe(false)
    expect(existsSync(target)).toBe(true)
    expect(await fs.readFile(path.join(target, "draft.txt"), "utf-8")).toBe("keep me")
    const checkout = simpleGit(target)
    await checkout.raw(["status"])
    expect((await checkout.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe("fix-token-refresh")
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).not.toContain(`worktree ${created.path.replaceAll("\\", "/")}`)
    expect(listed).toContain(`worktree ${target.replaceAll("\\", "/")}`)
  }, 30_000)

  it("reports a typed fatal error when branch rollback is refused", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const target = path.join(root, ".kilo", "worktrees", "fix-token-refresh")
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")

    const git = (manager as unknown as { git: { raw: (args: string[]) => Promise<string> } }).git
    const raw = git.raw.bind(git)
    git.raw = async (args) => {
      if (args[0] === "worktree" && args[1] === "move") throw new Error("native move refused")
      if (args[0] === "branch" && args[1] === "-m" && args[2] === "fix-token-refresh" && args[3] === created.branch) {
        throw new Error("branch restore refused")
      }
      return raw(args)
    }
    const realRename = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === created.path && String(to) === target) throw new Error("physical move refused")
      return realRename(from, to)
    })

    let failure: unknown
    try {
      await manager.renameWorktree(created.path, created.branch, "fix-token-refresh")
    } catch (error) {
      failure = error
    } finally {
      rename.mockRestore()
      git.raw = raw
    }

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toBeInstanceOf(WorktreeRollbackError)
    expect((failure as Error).message).toContain("branch restore refused")
    expect(failure).toMatchObject({ source: created.path, target, branch: "fix-token-refresh" })
    expect(existsSync(created.path)).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fs.readFile(file, "utf-8")).toBe("keep me")
    expect((await simpleGit(created.path).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe("fix-token-refresh")
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).toContain(`worktree ${created.path.replaceAll("\\", "/")}`)
    expect(listed).not.toContain(`worktree ${target.replaceAll("\\", "/")}`)
  }, 30_000)

  it("skips both branch and directory collisions", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const blocked = path.join(root, ".kilo", "worktrees", "fix-auth-2")
    await simpleGit(root).branch(["fix-auth"])
    await fs.mkdir(blocked, { recursive: true })

    const result = await manager.renameWorktree(created.path, created.branch, "fix-auth")

    expect(result.branch).toBe("fix-auth-3")
    expect(path.basename(result.path)).toBe(result.branch)
    expect(existsSync(blocked)).toBe(true)
    expect(existsSync(result.path)).toBe(true)
    expect(existsSync(created.path)).toBe(false)
  }, 30_000)

  it("refuses a branch present on a remote without changing it", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")
    const hash = (await simpleGit(root).revparse(["HEAD"])).trim()
    await simpleGit(root).raw(["update-ref", `refs/remotes/origin/${created.branch}`, hash])
    const before = await simpleGit(root).raw(["worktree", "list", "--porcelain"])

    await expect(manager.renameWorktree(created.path, created.branch, "fix-auth")).rejects.toThrow(
      "already exists on a remote",
    )
    expect(existsSync(created.path)).toBe(true)
    expect(await fs.readFile(file, "utf-8")).toBe("keep me")
    expect((await simpleGit(created.path).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(created.branch)
    expect((await simpleGit(root).branch()).all).not.toContain("fix-auth")
    expect(await simpleGit(root).raw(["worktree", "list", "--porcelain"])).toBe(before)
  }, 30_000)

  it("refuses a registered worktree outside the managed directory without mutation", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const foreign = path.join(root, "foreign-worktree")
    const target = path.join(root, ".kilo", "worktrees", "fix-auth")
    await fs.writeFile(path.join(created.path, "draft.txt"), "keep me")
    await fs.rename(created.path, foreign)
    await simpleGit(root).raw(["worktree", "repair", foreign])

    const refs = await simpleGit(root).raw(["show-ref"])
    const listed = await simpleGit(root).raw(["worktree", "list", "--porcelain"])

    let failure: unknown
    try {
      await manager.renameWorktree(foreign, created.branch, "fix-auth")
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fs.readFile(path.join(foreign, "draft.txt"), "utf-8")).toBe("keep me")
    expect((await simpleGit(foreign).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(created.branch)
    expect(await simpleGit(root).raw(["show-ref"])).toBe(refs)
    expect(await simpleGit(root).raw(["worktree", "list", "--porcelain"])).toBe(listed)
    expect((failure as Error).message).toContain("not managed by Agent Manager")
  }, 30_000)

  it("rejects a direct branch rename when the supplied current branch is stale", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const created = await manager.createWorktree({ branchName: "quiet-river" })
    const file = path.join(created.path, "draft.txt")
    await fs.writeFile(file, "keep me")
    await simpleGit(root).branch(["other-branch"])
    const refs = await simpleGit(root).raw(["show-ref"])
    const listed = await simpleGit(root).raw(["worktree", "list", "--porcelain"])

    let failure: unknown
    try {
      await manager.renameBranch(created.path, "other-branch", "fix-auth")
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(await fs.readFile(file, "utf-8")).toBe("keep me")
    expect(existsSync(created.path)).toBe(true)
    expect(existsSync(path.join(root, ".kilo", "worktrees", "fix-auth"))).toBe(false)
    expect((await simpleGit(created.path).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(created.branch)
    expect(await simpleGit(root).raw(["show-ref"])).toBe(refs)
    expect(await simpleGit(root).raw(["worktree", "list", "--porcelain"])).toBe(listed)
    expect((failure as Error).message).toContain("Branch changed before automatic naming")
  }, 30_000)

  it("rejects an unregistered repository inside the managed worktree directory", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const managed = await manager.createWorktree({ branchName: "quiet-river" })
    const standalone = await createTempRepo()
    await simpleGit(standalone).checkoutLocalBranch("quiet-river")
    const foreign = path.join(root, ".kilo", "worktrees", "unregistered")
    const target = path.join(root, ".kilo", "worktrees", "fix-rogue")
    await fs.rename(standalone, foreign)
    await fs.writeFile(path.join(foreign, "foreign.txt"), "standalone content")

    const refs = await simpleGit(root).raw(["show-ref"])
    const listed = await simpleGit(root).raw(["worktree", "list", "--porcelain"])
    let failure: unknown
    try {
      await manager.renameWorktree(foreign, "quiet-river", "fix-rogue")
    } catch (error) {
      failure = error
    }

    expect(await simpleGit(root).raw(["show-ref"])).toBe(refs)
    expect(existsSync(managed.path)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fs.readFile(path.join(foreign, "foreign.txt"), "utf-8")).toBe("standalone content")
    expect((await simpleGit(foreign).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe("quiet-river")
    expect(await simpleGit(root).raw(["worktree", "list", "--porcelain"])).toBe(listed)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("not registered")
  }, 30_000)
})

describe("WorktreeStateManager.renameOwnedWorktree", () => {
  it("updates the owned worktree path and clears automatic naming state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-state-rename-"))
    tempDirs.push(root)
    const state = new WorktreeStateManager(root, () => undefined)
    const wt = state.addWorktree({
      branch: "quiet-river",
      path: path.join(root, "quiet-river"),
      parentBranch: "main",
      branchOwned: true,
    })
    wt.originalBranch = "quiet-river"
    wt.autoNameSessionId = "session-1"
    wt.autoNamePromptCount = 2

    expect(
      state.renameOwnedWorktree(wt.id, "quiet-river", "fix-token-refresh", path.join(root, "fix-token-refresh")),
    ).toBe(true)
    await state.flush()

    expect(state.getWorktree(wt.id)).toMatchObject({
      branch: "fix-token-refresh",
      path: path.join(root, "fix-token-refresh"),
      branchOwned: true,
      originalBranch: undefined,
      autoNameSessionId: undefined,
      autoNamePromptCount: undefined,
    })

    const reloaded = new WorktreeStateManager(root, () => undefined)
    await reloaded.load()
    const saved = reloaded.getWorktree(wt.id)
    expect(saved?.branch).toBe("fix-token-refresh")
    expect(saved?.path).toBe(path.join(root, "fix-token-refresh"))
    expect(saved?.originalBranch).toBeUndefined()
    expect(saved?.autoNameSessionId).toBeUndefined()
    expect(saved?.autoNamePromptCount).toBeUndefined()
  })

  it("does not rename a worktree it does not own", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-state-rename-"))
    tempDirs.push(root)
    const state = new WorktreeStateManager(root, () => undefined)
    const wt = state.addWorktree({
      branch: "existing-feature",
      path: path.join(root, "existing-feature"),
      parentBranch: "main",
      branchOwned: false,
    })

    expect(
      state.renameOwnedWorktree(wt.id, "existing-feature", "fix-token-refresh", path.join(root, "fix-token-refresh")),
    ).toBe(false)
    expect(state.getWorktree(wt.id)).toMatchObject({
      branch: "existing-feature",
      path: path.join(root, "existing-feature"),
    })
    await state.flush()

    const reloaded = new WorktreeStateManager(root, () => undefined)
    await reloaded.load()
    expect(reloaded.getWorktree(wt.id)).toMatchObject({
      branch: "existing-feature",
      path: path.join(root, "existing-feature"),
      branchOwned: false,
    })
  })

  it("does not mutate owned state when the supplied current branch is stale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-state-rename-"))
    tempDirs.push(root)
    const state = new WorktreeStateManager(root, () => undefined)
    const wt = state.addWorktree({
      branch: "quiet-river",
      path: path.join(root, "quiet-river"),
      parentBranch: "main",
      branchOwned: true,
    })
    wt.autoNameSessionId = "session-1"
    wt.autoNamePromptCount = 1
    await state.save()
    await state.flush()

    expect(
      state.renameOwnedWorktree(wt.id, "other-branch", "fix-token-refresh", path.join(root, "fix-token-refresh")),
    ).toBe(false)
    await state.flush()

    const reloaded = new WorktreeStateManager(root, () => undefined)
    await reloaded.load()
    expect(reloaded.getWorktree(wt.id)).toMatchObject({
      branch: "quiet-river",
      path: path.join(root, "quiet-river"),
      branchOwned: true,
      autoNameSessionId: "session-1",
      autoNamePromptCount: 1,
    })
  })
})
