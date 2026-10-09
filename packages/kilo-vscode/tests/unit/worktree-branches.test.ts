import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { cleanup, createManager, createTempRepo } from "../helpers/worktree-fixtures"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// WorktreeManager -- ensureGitExclude
// ---------------------------------------------------------------------------

describe("WorktreeManager.ensureGitExclude", () => {
  it("adds Agent Manager state and worktrees to .git/info/exclude", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await mgr.ensureGitExclude()

    const content = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf-8")
    expect(content).toContain(".kilo/worktrees/")
    expect(content).toContain(".kilo/agent-manager.json")
  })

  it("adds only specific legacy Agent Manager paths", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await mgr.ensureGitExclude()

    const content = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf-8")
    expect(content).toContain(".kilocode/worktrees/")
    expect(content).toContain(".kilocode/agent-manager.json")
    expect(content).toContain(".kilocode/setup-script")
    expect(content).not.toContain("\n.kilocode/\n")
  })

  it("is idempotent -- does not duplicate entries", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await mgr.ensureGitExclude()
    await mgr.ensureGitExclude()
    await mgr.ensureGitExclude()

    const content = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf-8")
    const count = content.split(".kilo/worktrees/").length - 1
    expect(count).toBe(1)
  })

  it("prefixes ignore entries when the root is a subdirectory of the repository", async () => {
    const root = await createTempRepo()
    const sub = path.join(root, "packages", "app")
    await fs.mkdir(sub, { recursive: true })
    const mgr = createManager(sub)

    await mgr.ensureGitExclude()

    const content = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf-8")
    expect(content).toContain("packages/app/.kilo/worktrees/")
    expect(content).toContain("packages/app/.kilo/agent-manager.json")
  })

  it("keeps a subdirectory workspace clean after pool reconcile", async () => {
    const root = await createTempRepo()
    const sub = path.join(root, "packages", "app")
    await fs.mkdir(sub, { recursive: true })
    const mgr = createManager(sub)

    await mgr.reconcilePool()

    const status = await simpleGit(root).raw(["status", "--porcelain", "--untracked-files=all"])
    expect(status.trim()).toBe("")
    expect(existsSync(path.join(sub, ".kilo", "worktrees"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- automatic branch rename
// ---------------------------------------------------------------------------

describe("WorktreeManager.renameBranch", () => {
  it("renames a local-only branch without moving or cleaning the worktree", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const created = await mgr.createWorktree({ branchName: "quiet-river" })
    await fs.writeFile(path.join(created.path, "draft.txt"), "keep me")

    const branch = await mgr.renameBranch(created.path, created.branch, "fix-token-refresh")

    expect(branch).toBe("fix-token-refresh")
    expect((await simpleGit(created.path).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(branch)
    expect(await fs.readFile(path.join(created.path, "draft.txt"), "utf-8")).toBe("keep me")
    expect((await simpleGit(root).branch()).all).not.toContain(created.branch)
  })

  it("suffixes a generated name that already exists", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const created = await mgr.createWorktree({ branchName: "quiet-river" })
    await simpleGit(root).branch(["fix-auth"])

    expect(await mgr.renameBranch(created.path, created.branch, "fix-auth")).toBe("fix-auth-2")
  })

  it("does not rename a branch that exists on a remote", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const created = await mgr.createWorktree({ branchName: "quiet-river" })
    const hash = (await simpleGit(root).revparse(["HEAD"])).trim()
    await simpleGit(root).raw(["update-ref", `refs/remotes/origin/${created.branch}`, hash])

    await expect(mgr.renameBranch(created.path, created.branch, "fix-auth")).rejects.toThrow(
      "already exists on a remote",
    )
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- listBranches
// ---------------------------------------------------------------------------

describe("WorktreeManager.listBranches", () => {
  it("returns the current branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const { branches, defaultBranch } = await mgr.listBranches()

    const names = branches.map((b) => b.name)
    const git = simpleGit(root)
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    expect(names).toContain(current)
    expect(defaultBranch).toBeTruthy()
  })

  it("includes branches created after init", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    await git.branch(["feature-test"])

    const mgr = createManager(root)
    const { branches } = await mgr.listBranches()

    expect(branches.map((b) => b.name)).toContain("feature-test")
  })

  it("marks local branches as isLocal", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const { branches } = await mgr.listBranches()
    for (const b of branches) {
      expect(b.isLocal).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- checkedOutBranches
// ---------------------------------------------------------------------------

describe("WorktreeManager.checkedOutBranches", () => {
  it("includes the main branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const checked = await mgr.checkedOutBranches()
    const git = simpleGit(root)
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    expect(checked.has(current)).toBe(true)
  })

  it("includes worktree branches", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const wt = await mgr.createWorktree({ prompt: "checked-out-test" })
    const checked = await mgr.checkedOutBranches()

    expect(checked.has(wt.branch)).toBe(true)
  })

  it("excludes branches after worktree removal", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const wt = await mgr.createWorktree({ prompt: "removal-test" })
    await mgr.removeWorktree(wt.path)

    const checked = await mgr.checkedOutBranches()
    expect(checked.has(wt.branch)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- Start Point Resolution & Helpers
// ---------------------------------------------------------------------------

describe("WorktreeManager helpers", () => {
  it("refExistsLocally verifies refs", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const mgr = createManager(root)

    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    expect(await mgr.refExistsLocally(head)).toBe(true)
    expect(await mgr.refExistsLocally("nonexistent")).toBe(false)
    expect(await mgr.refExistsLocally("origin/HEAD")).toBe(false)
  })

  it("repoUsesLfs detects .gitattributes", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    expect(await mgr.repoUsesLfs()).toBe(false)

    await fs.writeFile(path.join(root, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text")
    expect(await mgr.repoUsesLfs()).toBe(true)
  })

  it("repoUsesLfs detects .git/lfs directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    expect(await mgr.repoUsesLfs()).toBe(false)

    await fs.mkdir(path.join(root, ".git", "lfs"), { recursive: true })
    expect(await mgr.repoUsesLfs()).toBe(true)
  })
})
