import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { changedFiles, cleanup, createManager, createTempRepo, gitExec, tempDirs } from "../helpers/worktree-fixtures"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// WorktreeManager -- session ID persistence
// ---------------------------------------------------------------------------

describe("WorktreeManager metadata", () => {
  it("round-trips writeMetadata / readMetadata with parentBranch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "session-test" })

    await mgr.writeMetadata(result.path, "sess-abc-123", "feature-branch", "origin")
    const meta = await mgr.readMetadata(result.path)

    expect(meta?.sessionId).toBe("sess-abc-123")
    expect(meta?.parentBranch).toBe("feature-branch")
    expect(meta?.remote).toBe("origin")
  })

  it("writes metadata outside the worktree checkout", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "session-status" })

    await mgr.writeMetadata(result.path, "sess-clean-123", "feature-branch", "origin")

    expect(existsSync(path.join(result.path, ".kilo", "session-id"))).toBe(false)
    expect(existsSync(path.join(result.path, ".kilo", "metadata.json"))).toBe(false)
    expect(await changedFiles(result.path)).toEqual([])
  })

  it("returns undefined when no metadata exists", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "no-session" })

    const meta = await mgr.readMetadata(result.path)
    expect(meta).toBeUndefined()
  })

  it("reads legacy session-id file when metadata.json is missing", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "legacy-test" })

    // Write only the legacy session-id file (no metadata.json)
    const dir = path.join(result.path, ".kilo")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "session-id"), "legacy-sess-456", "utf-8")

    const meta = await mgr.readMetadata(result.path)
    expect(meta?.sessionId).toBe("legacy-sess-456")
    expect(meta?.parentBranch).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- discoverWorktrees
// ---------------------------------------------------------------------------

describe("WorktreeManager.discoverWorktrees", () => {
  it("discovers worktrees with session IDs", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const wt1 = await mgr.createWorktree({ prompt: "discover-one" })
    const wt2 = await mgr.createWorktree({ prompt: "discover-two" })

    await mgr.writeMetadata(wt1.path, "sess-1", "main")
    await mgr.writeMetadata(wt2.path, "sess-2", "main")

    const discovered = await mgr.discoverWorktrees()

    expect(discovered.length).toBe(2)

    const ids = discovered.map((d) => d.sessionId).sort()
    expect(ids).toEqual(["sess-1", "sess-2"])

    for (const info of discovered) {
      expect(info.branch).toBeTruthy()
      expect(info.path).toBeTruthy()
      expect(info.parentBranch).toBeTruthy()
      expect(info.createdAt).toBeGreaterThan(0)
    }
  })

  it("returns empty array when no worktrees directory exists", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const discovered = await mgr.discoverWorktrees()
    expect(discovered).toEqual([])
  })

  it("includes worktrees without metadata (sessionId undefined)", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await mgr.createWorktree({ prompt: "no-session-id" })

    const discovered = await mgr.discoverWorktrees()
    expect(discovered.length).toBe(1)
    expect(discovered[0]?.sessionId).toBeUndefined()
  })

  it("recovers parentBranch from persisted metadata", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const wt = await mgr.createWorktree({ prompt: "parent-recovery" })
    await mgr.writeMetadata(wt.path, "sess-parent", "feature/my-branch")

    const discovered = await mgr.discoverWorktrees()
    const found = discovered.find((d) => d.sessionId === "sess-parent")

    expect(found).toBeDefined()
    expect(found!.parentBranch).toBe("feature/my-branch")
  })

  it("repairs stale gitdir refs when .kilo/worktrees already exists", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const worktree = path.join(root, ".kilo", "worktrees", "partial")
    const gitdir = path.join(root, ".git", "worktrees", "partial", "gitdir")
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(path.dirname(gitdir), { recursive: true })
    await fs.writeFile(gitdir, path.join(root, ".kilocode", "worktrees", "partial", ".git"), "utf-8")

    await mgr.discoverWorktrees()

    const fixed = await fs.readFile(gitdir, "utf-8")
    expect(fixed).toContain(path.join(root, ".kilo", "worktrees", "partial", ".git"))
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- scanWorktrees / restore / orphan removal
// ---------------------------------------------------------------------------

describe("WorktreeManager.scanWorktrees", () => {
  it("keeps the reason a directory is not usable", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const live = await mgr.createWorktree({ prompt: "live" })
    const leftover = path.join(root, ".kilo", "worktrees", "leftover")
    await fs.mkdir(path.join(leftover, ".kilo-dev"), { recursive: true })
    const broken = await mgr.createWorktree({ prompt: "broken" })
    // Hand-deleted registration: directory intact, git metadata gone.
    await fs.rm(path.join(root, ".git", "worktrees", path.basename(broken.path)), {
      recursive: true,
      force: true,
    })

    const probes = await mgr.scanWorktrees()
    const byPath = new Map(probes.map((probe) => [probe.ok ? probe.info.path : probe.path, probe]))

    expect(byPath.get(live.path)?.ok).toBe(true)
    expect(byPath.get(leftover)).toEqual({ ok: false, path: leftover, reason: "leftover" })
    expect(byPath.get(broken.path)).toEqual({ ok: false, path: broken.path, reason: "unregistered" })
    // discoverWorktrees keeps its old contract: healthy worktrees only.
    expect((await mgr.discoverWorktrees()).map((info) => info.path)).toEqual([live.path])
  })

  it("reports registered paths through a single git listing", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const wt = await mgr.createWorktree({ prompt: "registered" })

    const registered = await mgr.registeredPaths()

    expect(registered?.size).toBe(2) // main checkout + the new worktree
    expect(await mgr.worktreeDirs()).toEqual([path.basename(wt.path)])
  })
})

describe("WorktreeManager.restoreWorktree", () => {
  it("recreates a deleted worktree from its branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const wt = await mgr.createWorktree({ prompt: "restore-me" })
    await fs.writeFile(path.join(wt.path, "work.txt"), "committed work")
    gitExec(["git", "-C", wt.path, "add", "."])
    gitExec(["git", "-C", wt.path, "commit", "-m", "work"])
    await fs.rm(wt.path, { recursive: true, force: true })

    await mgr.restoreWorktree(wt.path, wt.branch)

    expect(existsSync(path.join(wt.path, "work.txt"))).toBe(true)
    expect((await mgr.discoverWorktrees()).map((info) => info.branch)).toEqual([wt.branch])
  })

  it("refuses paths outside the managed directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await expect(mgr.restoreWorktree(path.join(root, "elsewhere"), "main")).rejects.toThrow(/outside/)
  })

  it("refuses to overwrite an existing directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const wt = await mgr.createWorktree({ prompt: "occupied" })

    await expect(mgr.restoreWorktree(wt.path, wt.branch)).rejects.toThrow(/already exists/)
  })
})

describe("WorktreeManager.detachOrphanDirectory", () => {
  it("removes an untracked leftover directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const leftover = path.join(root, ".kilo", "worktrees", "leftover")
    await fs.mkdir(path.join(leftover, ".kilo-dev"), { recursive: true })

    const { done } = await mgr.detachOrphanDirectory(leftover)
    await done

    expect(existsSync(leftover)).toBe(false)
  })

  it("stages the directory instantly, before the background reap finishes", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const leftover = path.join(root, ".kilo", "worktrees", "leftover")
    await fs.mkdir(leftover, { recursive: true })

    const { done } = await mgr.detachOrphanDirectory(leftover)
    // The rename already happened by the time detachOrphanDirectory resolves: the original path is
    // gone even before `done` (the background reap) settles.
    expect(existsSync(leftover)).toBe(false)
    await done
  })

  it("refuses to remove a live worktree", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const wt = await mgr.createWorktree({ prompt: "live" })

    await expect(mgr.detachOrphanDirectory(wt.path)).rejects.toThrow(/live worktree/)
    expect(existsSync(wt.path)).toBe(true)
  })

  it("refuses paths outside the managed directory", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    await fs.mkdir(path.join(root, "outside"), { recursive: true })

    await expect(mgr.detachOrphanDirectory(path.join(root, "outside"))).rejects.toThrow(/outside/)
    expect(existsSync(path.join(root, "outside"))).toBe(true)
  })

  // The manager re-check is the only thing between a stale webview orphan list and a recursive
  // delete, so an unanswerable `git worktree list` has to fail closed. Not a repository at all is the
  // simplest way to make the listing fail for real.
  it("refuses to remove anything while git cannot list worktrees", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-nogit-"))
    tempDirs.push(root)
    const mgr = createManager(root)
    const leftover = path.join(root, ".kilo", "worktrees", "leftover")
    await fs.mkdir(leftover, { recursive: true })

    await expect(mgr.detachOrphanDirectory(leftover)).rejects.toThrow(/cannot list worktrees/)
    expect(existsSync(leftover)).toBe(true)
  })

  // Deterministic reappearance test: rather than racing the background reap (timing-dependent), the
  // original path is recreated *before* the private reap step runs, then the reap is invoked
  // directly so the retry path is exercised without depending on scheduling.
  it("retries once when the original path reappears after the reap", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const leftover = path.join(root, ".kilo", "worktrees", "leftover")
    await fs.mkdir(leftover, { recursive: true })
    const temp = path.join(root, ".kilo", "worktrees", ".kilo-delete-test")
    await fs.rename(leftover, temp)
    // Simulate a dev backend or the worktree pool recreating the directory while the reap of `temp`
    // was still in flight.
    await fs.mkdir(leftover, { recursive: true })

    const internal = mgr as unknown as { reapOrphan: (original: string, temp: string) => Promise<void> }
    await internal.reapOrphan(leftover, temp)

    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(temp)).toBe(false)
  })
})
