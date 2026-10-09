import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { cleanup, createManager, createTempRepo } from "../helpers/worktree-fixtures"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// WorktreeManager -- removeWorktree
// ---------------------------------------------------------------------------

describe("WorktreeManager.removeWorktree", () => {
  it("removes an existing worktree", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const result = await mgr.createWorktree({ prompt: "removeme" })
    expect(await fs.stat(result.path).then(() => true)).toBe(true)

    await mgr.removeWorktree(result.path)

    const exists = await fs
      .stat(result.path)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  }, 15_000)

  it("falls back to git removal when Windows prevents renaming the worktree", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const worktree = await manager.createWorktree({ branchName: "rename-blocked" })
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("directory busy"), { code: "EBUSY" }),
    )

    try {
      await manager.removeWorktree(worktree.path, worktree.branch)
      expect(existsSync(worktree.path)).toBe(false)
      expect((await simpleGit(root).branch()).all).not.toContain(worktree.branch)
    } finally {
      rename.mockRestore()
    }
  })

  it("keeps the branch when the worktree directory remains locked", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const worktree = await manager.createWorktree({ branchName: "locked-worktree" })
    await simpleGit(root).raw(["worktree", "lock", worktree.path])
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("directory busy"), { code: "EBUSY" }),
    )
    const remove = spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("directory busy"), { code: "EBUSY" }))

    try {
      await expect(manager.removeWorktree(worktree.path, worktree.branch)).rejects.toThrow("directory busy")
      expect(existsSync(worktree.path)).toBe(true)
      expect((await simpleGit(root).branch()).all).toContain(worktree.branch)
    } finally {
      rename.mockRestore()
      remove.mockRestore()
    }
  })

  it.skipIf(process.platform !== "win32")(
    "keeps a Windows worktree tracked while a live process locks its directory",
    async () => {
      const root = await createTempRepo()
      const manager = createManager(root)
      const worktree = await manager.createWorktree({ branchName: "windows-process-lock" })
      const child = Bun.spawn(
        [process.execPath, "-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
        {
          cwd: worktree.path,
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )

      try {
        const ready = await child.stdout.getReader().read()
        expect(Buffer.from(ready.value ?? []).toString()).toContain("ready")
        await expect(manager.removeWorktree(worktree.path, worktree.branch)).rejects.toThrow()
        expect(existsSync(worktree.path)).toBe(true)
        expect((await simpleGit(root).branch()).all).toContain(worktree.branch)
      } finally {
        child.kill()
        await child.exited
      }

      await manager.removeWorktree(worktree.path, worktree.branch)
      expect(existsSync(worktree.path)).toBe(false)
      expect((await simpleGit(root).branch()).all).not.toContain(worktree.branch)
    },
    30_000,
  )

  it("does not throw when worktree path does not exist", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Should not throw
    await mgr.removeWorktree(path.join(root, ".kilo", "worktrees", "nonexistent"))
  })

  it("removes orphaned directory that git does not know about", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Create an orphaned directory (not a real worktree)
    const orphanPath = path.join(root, ".kilo", "worktrees", "orphan")
    await fs.mkdir(orphanPath, { recursive: true })
    await fs.writeFile(path.join(orphanPath, "file.txt"), "orphan")

    await mgr.removeWorktree(orphanPath)

    const exists = await fs
      .stat(orphanPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("cleans up git metadata after removal", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const git = simpleGit(root)

    const result = await mgr.createWorktree({ prompt: "prune-check" })

    await mgr.removeWorktree(result.path)
    // Allow background rm to complete
    await new Promise((r) => setTimeout(r, 200))

    // git worktree list should only show the main repo
    const raw = await git.raw(["worktree", "list", "--porcelain"])
    const dirs = raw
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace("worktree ", ""))
    expect(dirs).toHaveLength(1)
  })

  it("deletes the local branch when branch is provided", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const git = simpleGit(root)

    const result = await mgr.createWorktree({ prompt: "branch-delete" })
    const branches = await git.branch()
    expect(branches.all).toContain(result.branch)

    await mgr.removeWorktree(result.path, result.branch)

    const after = await git.branch()
    expect(after.all).not.toContain(result.branch)
  })

  it("detaches the directory immediately and finishes git bookkeeping afterwards", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const git = simpleGit(root)
    const result = await mgr.createWorktree({ prompt: "detach-me" })

    const detached = await mgr.detachWorktree(result.path, result.branch)
    expect(existsSync(result.path)).toBe(false)

    await detached.done
    const raw = await git.raw(["worktree", "list", "--porcelain"])
    expect(raw.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1)
    expect((await git.branch()).all).not.toContain(result.branch)
  }, 15_000)

  it("detaches without waiting for the repository git lock", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "detach-locked" })

    // A pool refill or another creation can hold the git lock for seconds in large repositories.
    const hold = Promise.withResolvers<void>()
    const busy = mgr["withGitLock"](() => hold.promise)
    const detached = await mgr.detachWorktree(result.path, result.branch)
    expect(existsSync(result.path)).toBe(false)
    expect((await simpleGit(root).branch()).all).toContain(result.branch)

    hold.resolve()
    await busy
    // settle() flushes the deferred bookkeeping on dispose so branches are not orphaned.
    await mgr.settle()
    await detached.done
    expect((await simpleGit(root).branch()).all).not.toContain(result.branch)
  }, 20_000)

  it("falls back to locked removal when the directory cannot be renamed", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ branchName: "detach-rename-blocked" })
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("directory busy"), { code: "EBUSY" }),
    )

    try {
      const detached = await mgr.detachWorktree(result.path, result.branch)
      await detached.done
      expect(existsSync(result.path)).toBe(false)
      expect((await simpleGit(root).branch()).all).not.toContain(result.branch)
    } finally {
      rename.mockRestore()
    }
  })

  it("detach never rejects for an already missing directory and still drops the branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "detach-missing" })
    await fs.rm(result.path, { recursive: true, force: true })

    const detached = await mgr.detachWorktree(result.path, result.branch)
    await detached.done
    expect((await simpleGit(root).branch()).all).not.toContain(result.branch)
  })

  it("keeps the branch when branch param is omitted", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const git = simpleGit(root)

    const result = await mgr.createWorktree({ prompt: "keep-branch" })
    await mgr.removeWorktree(result.path)

    const after = await git.branch()
    expect(after.all).toContain(result.branch)
  })

  it(
    "returns quickly even with a dirty worktree",
    async () => {
      const root = await createTempRepo()
      const mgr = createManager(root)

      const result = await mgr.createWorktree({ prompt: "dirty-wt" })

      // Make the worktree dirty with uncommitted files
      await fs.writeFile(path.join(result.path, "dirty.txt"), "uncommitted")
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(path.join(result.path, `bulk-${i}.txt`), "x".repeat(1000))
      }

      const start = Date.now()
      await mgr.removeWorktree(result.path)
      const elapsed = Date.now() - start

      // The blocking portion (rename + prune) should complete well under 3s.
      // Old approach with git worktree remove (non-force then force) was much slower.
      expect(elapsed).toBeLessThan(3000)

      // Original path should be gone immediately
      const exists = await fs
        .stat(result.path)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    },
    { timeout: 15000 },
  )

  it(
    "eventual cleanup: files are fully deleted after background rm",
    async () => {
      const root = await createTempRepo()
      const mgr = createManager(root)

      const result = await mgr.createWorktree({ prompt: "eventual" })
      await fs.writeFile(path.join(result.path, "data.txt"), "content")

      await mgr.removeWorktree(result.path)

      // Poll until background rm finishes (up to 5s)
      const worktreesDir = path.join(root, ".kilo", "worktrees")
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const entries = await fs.readdir(worktreesDir)
        if (!entries.some((e) => e.startsWith(".kilo-delete-"))) break
        await new Promise((r) => setTimeout(r, 100))
      }

      // No .kilo-delete-* temp dirs should remain
      const entries = await fs.readdir(worktreesDir)
      const orphans = entries.filter((e) => e.startsWith(".kilo-delete-"))
      expect(orphans).toHaveLength(0)
    },
    { timeout: 10000 },
  )
})

// ---------------------------------------------------------------------------
// WorktreeManager -- discoverWorktrees cleans orphaned temp dirs
// ---------------------------------------------------------------------------

describe("WorktreeManager.discoverWorktrees orphan cleanup", () => {
  it("cleans up .kilo-delete-* dirs left by interrupted deletions", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Create a worktree so the worktrees directory exists
    const wt = await mgr.createWorktree({ prompt: "real-wt" })

    // Simulate an orphaned temp dir from an interrupted deletion
    const orphan = path.join(root, ".kilo", "worktrees", ".kilo-delete-fake-uuid")
    await fs.mkdir(orphan, { recursive: true })
    await fs.writeFile(path.join(orphan, "leftover.txt"), "stale")

    const discovered = await mgr.discoverWorktrees()

    // Should only discover the real worktree, not the orphan
    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.branch).toBe(wt.branch)

    // Wait for background cleanup
    await new Promise((r) => setTimeout(r, 300))

    const exists = await fs
      .stat(orphan)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- removeWorktree safety guard
// ---------------------------------------------------------------------------

describe("WorktreeManager.removeWorktree safety", () => {
  it("refuses to remove paths outside the worktrees directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Create a directory outside .kilo/worktrees/
    const outside = path.join(root, "important-data")
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, "file.txt"), "precious")

    // Attempt to remove it — should be silently refused
    await mgr.removeWorktree(outside)

    // Directory should still exist
    const exists = await fs
      .stat(outside)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })
})
