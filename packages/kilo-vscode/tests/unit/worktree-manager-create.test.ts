import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { cleanup, createManager, createTempRepo, gitExec, tempDirs } from "../helpers/worktree-fixtures"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// WorktreeManager -- createWorktree
// ---------------------------------------------------------------------------

describe("WorktreeManager.createWorktree", () => {
  it.each([
    "Feature/My_fix.v2",
    "Release_" + "a".repeat(60),
    ...(process.platform === "win32" ? [] : ["CON", 'fix/a"b<c>d|e']),
  ])("preserves explicit branch %s with a safe directory", async (branch) => {
    const root = await createTempRepo()
    const result = await createManager(root).createWorktree({ branchName: branch })
    expect(result.branch).toBe(branch)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(branch)
    expect(path.dirname(result.path)).toBe(path.join(root, ".kilo", "worktrees"))
    expect(path.basename(result.path)).toMatch(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/)
    expect(path.basename(result.path)).not.toBe("CON")
  })

  it.each(["../escape", "bad name", "bad..name", "bad.lock", "-option", "@{-1}", "HEAD", ""])(
    "rejects invalid explicit branch %s before creating directories",
    async (branchName) => {
      const root = await createTempRepo()
      await expect(createManager(root).createWorktree({ branchName })).rejects.toThrow()
      expect(existsSync(path.join(root, ".kilo", "worktrees"))).toBe(false)
    },
  )

  it("keeps slash refs independent from flat refs and preserves collision suffixes", async () => {
    const root = await createTempRepo()
    const manager = createManager(root)
    const first = await manager.createWorktree({ branchName: "Feature/My_fix.v2" })
    const flat = await manager.createWorktree({ branchName: "Feature-My_fix.v2" })
    const second = await manager.createWorktree({ branchName: "Feature/My_fix.v2" })
    expect(flat.branch).toBe("Feature-My_fix.v2")
    expect(second.branch).toBe("Feature/My_fix.v2-2")
    expect(new Set([first.path, flat.path, second.path]).size).toBe(3)
  })

  it("uses a configured Git executable for worktree creation", async () => {
    const root = await createTempRepo()
    gitExec(["git", "-C", root, "config", "core.autocrlf", "false"])
    gitExec(["git", "-C", root, "config", "core.eol", "lf"])
    const real = Bun.which("git")
    if (!real) throw new Error("Git is required for this test")

    const fake = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-no-git-"))
    tempDirs.push(fake)
    const file = path.join(fake, process.platform === "win32" ? "git.cmd" : "git")
    await fs.writeFile(file, process.platform === "win32" ? "@exit /b 127\r\n" : "#!/bin/sh\nexit 127\n")
    if (process.platform !== "win32") await fs.chmod(file, 0o755)

    const bin =
      process.platform === "win32"
        ? real
        : path.join(await fs.mkdtemp(path.join(os.tmpdir(), "kilo-git executable-")), "git")
    if (process.platform !== "win32") {
      const dir = path.dirname(bin)
      tempDirs.push(dir)
      await fs.symlink(real, bin)
    }

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string" && key.toLowerCase() !== "path") env[key] = value
    }
    const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH"
    const dirs = [fake]
    if (process.platform === "win32") {
      const root = process.env.SystemRoot ?? process.env.windir
      if (root) {
        dirs.push(
          path.join(root, "System32"),
          path.join(root, "System32", "Wbem"),
          path.join(root, "System32", "WindowsPowerShell", "v1.0"),
        )
      }
    }
    env[key] = dirs.join(path.delimiter)
    env.KILO_TEST_ROOT = root
    env.KILO_TEST_GIT = bin

    const script = `
      import { existsSync } from "node:fs"
      import path from "node:path"
      import { GitOps } from "./src/agent-manager/GitOps"
      import { apply, capture } from "./src/agent-manager/git-transfer"
      import { WorktreeManager } from "./src/agent-manager/WorktreeManager"

      const root = process.env.KILO_TEST_ROOT
      const git = process.env.KILO_TEST_GIT
      if (!root || !git) throw new Error("Missing configured Git test environment")

      const ops = new GitOps({ log: () => undefined, binary: git })
      const manager = new WorktreeManager(root, () => undefined, ops)
      const result = await manager.createWorktree({ branchName: "configured-git" })
      if (!existsSync(path.join(result.path, ".git"))) throw new Error("Worktree was not created")
      if ((await ops.currentBranch(result.path)) !== result.branch) throw new Error("GitOps did not use configured Git")
      if (await manager.hasWork(result.path, result.parentBranch)) throw new Error("New worktree unexpectedly has work")
      await Bun.write(path.join(result.path, "configured.txt"), "configured")
      if (!(await manager.hasWork(result.path, result.parentBranch))) throw new Error("WorktreeManager did not use configured Git")
      await Bun.write(path.join(root, "README.md"), "staged\\n")
      const staged = await ops.execGit(["add", "README.md"], root)
      if (staged.code !== 0) throw new Error("Could not stage configured Git test change")
      await Bun.write(path.join(root, "README.md"), "unstaged\\n")
      const snapshot = await capture(root, () => undefined, git)
      if (!snapshot.staged?.includes("staged") || !snapshot.unstaged?.includes("unstaged")) {
        throw new Error("Git transfer did not capture staged and unstaged changes")
      }
      const applied = await apply(snapshot, result.path, () => undefined, git)
      if (!applied.ok) throw new Error(applied.error ?? "Git transfer did not apply changes")
      if ((await Bun.file(path.join(result.path, "README.md")).text()) !== "unstaged\\n") {
        throw new Error("Git transfer did not apply the working tree content")
      }
      const status = (await ops.execGit(["status", "--porcelain", "--", "README.md"], result.path)).stdout.trim()
      if (status !== "MM README.md") throw new Error("Git transfer did not preserve staged state: " + status)
    `
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = child.stderr.toString("utf8")

    expect(child.exitCode, stderr).toBe(0)
    expect(existsSync(path.join(root, ".kilo", "worktrees", "configured-git", ".git"))).toBe(true)
  }, 120_000)

  it("creates a worktree with a new branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const result = await mgr.createWorktree({ prompt: "test task" })

    // Branch should be a friendly two-word name (e.g. "brave-piano")
    expect(result.branch).toMatch(/^[a-z]+-[a-z]+/)
    expect(result.parentBranch).toBeTruthy()

    // Worktree directory should exist and have a .git file (not directory)
    const stat = await fs.stat(path.join(result.path, ".git"))
    expect(stat.isFile()).toBe(true)

    // Branch should exist in the repo
    const git = simpleGit(root)
    const branches = await git.branch()
    expect(branches.all).toContain(result.branch)
  })

  it("uses existing branch when specified", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    await git.branch(["feature-branch"])

    const mgr = createManager(root)
    const result = await mgr.createWorktree({ existingBranch: "feature-branch" })

    expect(result.branch).toBe("feature-branch")
    const stat = await fs.stat(path.join(result.path, ".git"))
    expect(stat.isFile()).toBe(true)
  })

  it("throws when existing branch does not exist", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await expect(mgr.createWorktree({ existingBranch: "nonexistent" })).rejects.toThrow(
      'Branch "nonexistent" does not exist',
    )
  })

  it("reports when an explicit base branch is selected in a repository with no commits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-empty-"))
    tempDirs.push(root)
    gitExec(["git", "init", "-b", "main", root])

    await expect(createManager(root).createWorktree({ baseBranch: "main", branchName: "feature" })).rejects.toThrow(
      "This repository has no commits yet. Create an initial commit before using worktrees.",
    )
  })

  it("allows an explicit base branch from an orphan current branch", async () => {
    const root = await createTempRepo()
    gitExec(["git", "-C", root, "checkout", "--orphan", "orphan"])
    gitExec(["git", "-C", root, "rm", "-rf", "."])

    const result = await createManager(root).createWorktree({ baseBranch: "main", branchName: "feature" })

    expect(result.parentBranch).toBe("main")
  })

  it("throws when workspace is not a git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-nogit-"))
    tempDirs.push(dir)
    const mgr = createManager(dir)

    await expect(mgr.createWorktree({ prompt: "test" })).rejects.toThrow("not a git repository")
  })

  it("creates worktrees directory under .kilo/worktrees/", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const result = await mgr.createWorktree({ prompt: "test" })

    expect(result.path).toContain(path.join(".kilo", "worktrees"))
  })

  it("records parentBranch as default branch", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()

    const mgr = createManager(root)
    const result = await mgr.createWorktree({ prompt: "test" })

    expect(result.parentBranch).toBe(branch)
  })

  it("uses four checkout workers without changing Git configuration", async () => {
    const root = await createTempRepo()
    const hook = path.join(root, ".git", "hooks", "post-checkout")
    const file = path.join(root, "workers")
    await fs.writeFile(hook, `#!/bin/sh\ngit config --get checkout.workers > "${file}"\n`)
    await fs.chmod(hook, 0o755)

    await createManager(root).createWorktree({ branchName: "parallel-checkout" })

    expect((await fs.readFile(file, "utf8")).trim()).toBe("4")
    expect((await simpleGit(root).getConfig("checkout.workers")).value).toBeNull()
  })

  it("preserves an explicitly configured checkout worker count", async () => {
    const root = await createTempRepo()
    const hook = path.join(root, ".git", "hooks", "post-checkout")
    const file = path.join(root, "workers")
    gitExec(["git", "-C", root, "config", "checkout.workers", "1"])
    await fs.writeFile(hook, `#!/bin/sh\ngit config --get checkout.workers > "${file}"\n`)
    await fs.chmod(hook, 0o755)

    await createManager(root).createWorktree({ branchName: "configured-checkout" })

    expect((await fs.readFile(file, "utf8")).trim()).toBe("1")
    expect((await simpleGit(root).getConfig("checkout.workers")).value).toBe("1")
  })

  it("retains post-checkout hook failure tolerance with parallel checkout", async () => {
    const root = await fs.realpath(await createTempRepo())
    const hook = path.join(root, ".git", "hooks", "post-checkout")
    await fs.writeFile(hook, "#!/bin/sh\nprintf 'post-checkout hook failed' >&2\nexit 1\n")
    await fs.chmod(hook, 0o755)

    const result = await createManager(root).createWorktree({ branchName: "hook-failure" })

    expect(existsSync(result.path)).toBe(true)
    // `worktree list --porcelain` prints forward slashes on every platform.
    const listed = (await simpleGit(root).raw(["worktree", "list", "--porcelain"])).replaceAll("\\", "/")
    expect(listed).toContain(result.path.replaceAll("\\", "/"))
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- createWorktree cleans up leftover directories
// ---------------------------------------------------------------------------

describe("WorktreeManager.createWorktree cleanup", () => {
  it("cleans up leftover worktree directory before re-creation", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Create a worktree, then remove it improperly (just delete via git but leave artifacts)
    const first = await mgr.createWorktree({ existingBranch: undefined, prompt: "cleanup-test" })
    const branch = first.branch

    // Remove the worktree properly, then recreate the directory as an orphan
    // to simulate a crash that left a stale directory
    await mgr.removeWorktree(first.path)
    await fs.mkdir(first.path, { recursive: true })
    await fs.writeFile(path.join(first.path, "stale.txt"), "leftover")

    // Creating a worktree with the same branch name (via existingBranch) should
    // clean up the stale directory and succeed
    const second = await mgr.createWorktree({ existingBranch: branch })

    expect(second.branch).toBe(branch)
    expect(second.path).toBe(first.path)
    const gitFile = await fs.stat(path.join(second.path, ".git"))
    expect(gitFile.isFile()).toBe(true)

    // Stale file should be gone
    const staleExists = await fs
      .stat(path.join(second.path, "stale.txt"))
      .then(() => true)
      .catch(() => false)
    expect(staleExists).toBe(false)
  })
})
