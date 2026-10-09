import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
import { simpleGit } from "simple-git"
import { GitOps } from "../../src/agent-manager/GitOps"
import type { PRInfo } from "../../src/agent-manager/git-import"
import { BUDGET } from "../../src/agent-manager/command-budget"
import {
  changedFiles,
  cleanup,
  createManager,
  createTempRepo,
  createTempRepoWithOrigin,
  gitExec,
} from "../helpers/worktree-fixtures"

afterEach(cleanup)

describe("WorktreeManager.createFromPR", () => {
  it("reports a timed-out gh lookup as a timeout, not as an unexplained failure", async () => {
    // The import path a user reaches by pasting a PR url ran gh on a 30s budget and classified the
    // failure from text a killed process never produces, so a hang read as "Failed to fetch PR info".
    const root = await createTempRepo()
    const manager = createManager(root)
    const internal = manager as unknown as { gh: (args: string[], timeout?: number) => Promise<string> }
    const budgets: (number | undefined)[] = []
    internal.gh = async (_args, timeout) => {
      budgets.push(timeout)
      throw Object.assign(new Error("Command failed: gh pr view 1"), { killed: true, signal: "SIGTERM" })
    }

    const failure = await manager.createFromPR("https://github.com/org/repo/pull/1").then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )

    expect(failure).toBe("GitHub CLI (gh) did not respond in time. Try again.")
    expect(budgets).toEqual([BUDGET.gh])
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- branch name collision retry
// ---------------------------------------------------------------------------

describe("WorktreeManager.createWorktree branch collision", () => {
  it("preserves an unrelated dirty worktree when an existing slash branch hashes to its literal name", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const branch = "Feature/My_fix.v2"
    const original = await mgr.createWorktree({ branchName: branch })
    const literal = path.basename(original.path)
    await mgr.removeWorktree(original.path)
    const other = await mgr.createWorktree({ branchName: literal })
    const file = path.join(other.path, "draft.txt")
    await fs.writeFile(file, "uncommitted work")
    const occupied = `${other.path}-2`
    await fs.mkdir(occupied)
    await fs.writeFile(path.join(occupied, "keep.txt"), "keep")

    const result = await mgr.createWorktree({ existingBranch: branch })

    expect(result.branch).toBe(branch)
    expect(result.path).toBe(`${other.path}-3`)
    expect((await simpleGit(result.path).raw(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${branch}`)
    expect((await simpleGit(other.path).raw(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${literal}`)
    expect(await fs.readFile(file, "utf8")).toBe("uncommitted work")
    expect(await changedFiles(other.path)).toEqual(["?? draft.txt"])
    expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("keep")
    expect(await mgr.checkedOutBranches()).toEqual(new Set(["main", literal, branch]))
  })

  it("creates a suffixed worktree without replacing an active explicitly named worktree", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const first = await mgr.createWorktree({ branchName: "echo-hello-world" })
    const second = await mgr.createWorktree({ branchName: "echo-hello-world" })

    expect(first.branch).toBe("echo-hello-world")
    expect(second.branch).toBe("echo-hello-world-2")
    expect((await fs.stat(path.join(first.path, ".git"))).isFile()).toBe(true)
    expect((await fs.stat(path.join(second.path, ".git"))).isFile()).toBe(true)
    expect((await simpleGit(root).branch()).all.filter((branch) => branch.startsWith("echo-hello-world"))).toEqual([
      "echo-hello-world",
      "echo-hello-world-2",
    ])
  })

  it("uses the same suffix sequence when only the requested branch already exists", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const mgr = createManager(root)
    const first = await mgr.createWorktree({ branchName: "collide" })

    await git.raw(["worktree", "remove", "--force", first.path])
    expect((await git.branch()).all).toContain("collide")

    const second = await mgr.createWorktree({ branchName: "collide" })

    expect(second.branch).toBe("collide-2")
    expect((await fs.stat(path.join(second.path, ".git"))).isFile()).toBe(true)
  })

  it("does not treat remote-tracking refs as local branch collisions", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const hash = (await git.revparse(["HEAD"])).trim()
    await git.raw(["update-ref", "refs/remotes/origin/remote-name", hash])

    const result = await createManager(root).createWorktree({ branchName: "remote-name" })

    expect(result.branch).toBe("remote-name")
  })
})

describe("WorktreeManager.resolveStartPoint", () => {
  it("falls back to local branch when no remote exists", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    const mgr = createManager(root)

    const res = await mgr.resolveStartPoint(head)
    expect(res.source).toBe("local-branch")
    expect(res.ref).toBe(head)
  })

  it("returns bare branch + remote when remote exists", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const mgr = createManager(clone)

    const res = await mgr.resolveStartPoint("main")
    expect(res.source).toBe("remote")
    expect(res.ref).toBe("origin/main")
    expect(res.branch).toBe("main")
    expect(res.remote).toBe("origin")
  })

  it("returns bare branch + remote for stale tracking ref", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    // Remove origin so fetch fails, but the local tracking ref remains
    await git.removeRemote("origin")
    const mgr = createManager(clone)

    const res = await mgr.resolveStartPoint("main")
    // After removing the remote, resolveRemote() returns undefined,
    // so "origin/main" won't be tried as ${remote}/${branch}. Falls back to local.
    expect(res.source).toBe("local-branch")
    expect(res.branch).toBe("main")
    expect(res.remote).toBeUndefined()
  })

  it("returns bare branch name for local-only source", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    const mgr = createManager(root)

    const res = await mgr.resolveStartPoint(head)
    expect(res.source).toBe("local-branch")
    expect(res.branch).toBe(head)
    expect(res.remote).toBeUndefined()
  })

  it("falls back to default branch when requested does not exist", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    const mgr = createManager(root)

    const res = await mgr.resolveStartPoint("nonexistent-feature")
    expect(res.source).toBe("fallback")
    expect(res.branch).toBe(head) // fallback to default (HEAD)
    expect(res.warning).toContain("falling back to")
  })

  it("does not fallback when allowFallback is false", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    await expect(mgr.resolveStartPoint("nonexistent", undefined, { allowFallback: false })).rejects.toThrow(
      "Could not resolve start point",
    )
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- resolveBaseBranch
// ---------------------------------------------------------------------------

describe("WorktreeManager.resolveBaseBranch", () => {
  it("uses the shared remote default instead of stale local metadata", async () => {
    const { clone } = await createTempRepoWithOrigin()
    gitExec(["git", "-C", clone, "branch", "master"])
    gitExec(["git", "-C", clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"])
    const ops = new GitOps({
      log: () => undefined,
      runGit: async (args) => {
        if (args[0] === "rev-parse" && args[3] === "@{upstream}") return "origin/main"
        if (args[0] === "ls-remote") return "ref: refs/heads/main\tHEAD\nabc123\tHEAD"
        return ""
      },
    })
    const mgr = createManager(clone, ops)

    expect(await mgr.resolveBaseBranch()).toEqual({ branch: "main", remote: "origin" })
    expect((await simpleGit(clone).raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim()).toBe(
      "origin/master",
    )
  })

  it("returns bare branch + remote when origin remote and tracking ref exist", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const mgr = createManager(clone)

    const result = await mgr.resolveBaseBranch()
    expect(result).toEqual({ branch: "main", remote: "origin" })
  })

  it("returns bare branch without remote when no origin remote exists", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const result = await mgr.resolveBaseBranch()
    const git = simpleGit(root)
    const head = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    expect(result).toEqual({ branch: head })
    expect(result.remote).toBeUndefined()
  })

  it("returns bare branch without remote when origin exists but tracking ref does not", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    // Add a remote that points nowhere — origin exists but origin/main ref doesn't
    await git.addRemote("origin", "https://example.com/repo.git")
    const mgr = createManager(root)

    const result = await mgr.resolveBaseBranch()
    const git2 = simpleGit(root)
    const head = (await git2.revparse(["--abbrev-ref", "HEAD"])).trim()
    expect(result).toEqual({ branch: head })
    expect(result.remote).toBeUndefined()
  })
})

describe("WorktreeManager.createWorktree advanced", () => {
  it("returns startPointSource in result", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const res = await mgr.createWorktree({ prompt: "source-test" })

    expect(res.startPointSource).toBe("local-branch") // no remote in temp repo
  })

  it("does not set upstream tracking on new branch", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const res = await mgr.createWorktree({ prompt: "no-upstream" })

    const git = simpleGit(res.path)
    // Checking upstream should fail
    let error
    try {
      await git.revparse(["--abbrev-ref", `${res.branch}@{upstream}`])
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
  })

  it("fires onProgress callbacks", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)
    const steps: string[] = []

    await mgr.createWorktree({
      prompt: "progress-test",
      onProgress: (step) => steps.push(step),
    })

    expect(steps).toContain("verifying")
    expect(steps).toContain("creating")
  })

  it("creates from an explicitly selected base branch", async () => {
    const root = await createTempRepo()
    const git = simpleGit(root)
    const mgr = createManager(root)

    // Create a new branch 'develop'
    await git.checkoutLocalBranch("develop")
    await fs.writeFile(path.join(root, "dev.txt"), "dev")
    await git.add(".")
    await git.commit("dev commit")

    // Create worktree from 'develop'
    const res = await mgr.createWorktree({
      prompt: "feature",
      baseBranch: "develop",
    })

    expect(res.parentBranch).toBe("develop")
    const wtGit = simpleGit(res.path)
    const headParams = await wtGit.log(["-1"])
    const devParams = await git.log(["-1"])
    expect(headParams.latest?.hash).toBe(devParams.latest?.hash)
  })

  it("creates from a base branch excluded by the remote fetch refspec", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    await git.checkout("main")

    await git.raw(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
    await git.raw(["update-ref", "-d", "refs/remotes/origin/topic"])

    const result = await createManager(clone).createWorktree({ baseBranch: "topic", prompt: "from topic" })
    const remoteHead = (await git.revparse(["refs/remotes/origin/topic"])).trim()
    const worktreeHead = (await simpleGit(result.path).revparse(["HEAD"])).trim()

    expect(worktreeHead).toBe(remoteHead)
    expect(result.parentBranch).toBe("topic")
  })

  it("fetches the base branch when guarded git variables are inherited", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    await git.checkout("main")
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
    await git.raw(["update-ref", "-d", "refs/remotes/origin/topic"])

    const prev = { visual: process.env.VISUAL, author: process.env.GIT_AUTHOR_NAME }
    process.env.VISUAL = "true"
    process.env.GIT_AUTHOR_NAME = "Kilo"
    const result = await createManager(clone)
      .createWorktree({ baseBranch: "topic", prompt: "from topic" })
      .finally(() => {
        if (prev.visual == null) delete process.env.VISUAL
        if (prev.visual != null) process.env.VISUAL = prev.visual
        if (prev.author == null) delete process.env.GIT_AUTHOR_NAME
        if (prev.author != null) process.env.GIT_AUTHOR_NAME = prev.author
      })
    const remoteHead = (await git.revparse(["refs/remotes/origin/topic"])).trim()
    const worktreeHead = (await simpleGit(result.path).revparse(["HEAD"])).trim()

    expect(worktreeHead).toBe(remoteHead)
  })

  it("does not fetch with an inherited GIT_SSH_COMMAND", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    await git.checkout("main")
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
    await git.raw(["update-ref", "-d", "refs/remotes/origin/topic"])

    const prev = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = "ssh"
    const err = await createManager(clone)
      .prefetchBase("topic")
      .then(
        () => undefined,
        (e: unknown) => e,
      )
      .finally(() => {
        if (prev == null) delete process.env.GIT_SSH_COMMAND
        if (prev != null) process.env.GIT_SSH_COMMAND = prev
      })

    expect(String(err)).toContain("inherited GIT_SSH_COMMAND")
    expect(await git.raw(["for-each-ref", "refs/remotes/origin/topic"])).toBe("")
  })

  it("creates from a same-repository PR branch excluded by the remote fetch refspec", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    await git.checkout("main")
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
    await git.raw(["update-ref", "-d", "refs/remotes/origin/topic"])
    await git.branch(["-D", "topic"])

    const manager = createManager(clone)
    const internal = manager as unknown as {
      fetchPRInfo: (parsed: { owner: string; repo: string; number: number }) => Promise<PRInfo>
    }
    internal.fetchPRInfo = async () => ({
      headRefName: "topic",
      baseRefName: "main",
      isCrossRepository: false,
      title: "Topic PR",
    })

    const result = await manager.createFromPR("https://github.com/org/repo/pull/1")
    const remoteHead = (await git.revparse(["refs/remotes/origin/topic"])).trim()
    const worktreeHead = (await simpleGit(result.path).revparse(["HEAD"])).trim()

    expect(worktreeHead).toBe(remoteHead)
    expect(result.parentBranch).toBe("main")
    expect(result.remote).toBe("origin")
  }, 60_000)

  it("does not track a deleted PR source branch when using the pull ref fallback", async () => {
    const { bare, clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    const head = (await git.revparse(["topic"])).trim()
    await git.checkout("main")
    await git.raw(["config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"])
    await git.raw(["update-ref", "-d", "refs/remotes/origin/topic"])
    gitExec(["git", "--git-dir", bare, "update-ref", "refs/pull/1/head", head])
    gitExec(["git", "--git-dir", bare, "update-ref", "-d", "refs/heads/topic"])
    await git.branch(["-D", "topic"])

    const manager = createManager(clone)
    const internal = manager as unknown as {
      fetchPRInfo: (parsed: { owner: string; repo: string; number: number }) => Promise<PRInfo>
    }
    internal.fetchPRInfo = async () => ({
      headRefName: "topic",
      isCrossRepository: false,
      title: "Topic PR",
    })

    const result = await manager.createFromPR("https://github.com/org/repo/pull/1")
    const upstream = await git.raw(["config", "--get", "branch.topic.remote"]).catch(() => "")
    const worktreeHead = (await simpleGit(result.path).revparse(["HEAD"])).trim()

    expect(worktreeHead).toBe(head)
    expect(upstream.trim()).toBe("")
    expect(result.parentBranch).toBe("main")
    expect(result.remote).toBe("origin")
  }, 60_000)

  it("preserves a non-default PR target branch for comparison", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const git = simpleGit(clone)
    await git.checkoutLocalBranch("develop")
    await fs.writeFile(path.join(clone, "develop.txt"), "develop")
    await git.add(".")
    await git.commit("develop commit")
    await git.push("origin", "develop")
    await git.checkout("main")
    await git.checkoutLocalBranch("topic")
    await fs.writeFile(path.join(clone, "topic.txt"), "topic")
    await git.add(".")
    await git.commit("topic commit")
    await git.push("origin", "topic")
    await git.checkout("main")

    const manager = createManager(clone)
    const internal = manager as unknown as {
      fetchPRInfo: (parsed: { owner: string; repo: string; number: number }) => Promise<PRInfo>
    }
    internal.fetchPRInfo = async () => ({
      headRefName: "topic",
      baseRefName: "develop",
      isCrossRepository: false,
      title: "Topic PR",
    })

    const result = await manager.createFromPR("https://github.com/org/repo/pull/1")
    const target = (await git.revparse(["refs/remotes/origin/develop"])).trim()
    const head = (await simpleGit(result.path).revparse(["HEAD"])).trim()

    expect(result.parentBranch).toBe("develop")
    expect(result.remote).toBe("origin")
    expect(head).not.toBe(target)
  }, 60_000)

  it("fails before creating a worktree for an unavailable PR target", async () => {
    const { clone } = await createTempRepoWithOrigin()
    const manager = createManager(clone)
    const internal = manager as unknown as {
      fetchPRInfo: (parsed: { owner: string; repo: string; number: number }) => Promise<PRInfo>
    }
    internal.fetchPRInfo = async () => ({
      headRefName: "topic",
      baseRefName: "missing",
      isCrossRepository: false,
      title: "Topic PR",
    })

    await expect(manager.createFromPR("https://github.com/org/repo/pull/1")).rejects.toThrow(
      'Could not resolve start point for branch "missing"',
    )
    expect(existsSync(path.join(clone, ".kilo", "worktrees"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// WorktreeManager -- git lock serialization
// ---------------------------------------------------------------------------

describe("WorktreeManager git lock serialization", () => {
  it("concurrent worktree creations both succeed", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    const [a, b] = await Promise.all([
      mgr.createWorktree({ prompt: "concurrent-a" }),
      mgr.createWorktree({ prompt: "concurrent-b" }),
    ])

    expect(a.branch).not.toBe(b.branch)

    const statA = await fs.stat(path.join(a.path, ".git"))
    const statB = await fs.stat(path.join(b.path, ".git"))
    expect(statA.isFile()).toBe(true)
    expect(statB.isFile()).toBe(true)
  })

  it("lock releases after error so subsequent operations succeed", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // First operation fails (nonexistent branch)
    const failing = mgr.createWorktree({ existingBranch: "nonexistent" }).catch((e: unknown) => e)
    // Second operation queues behind the first and should succeed after lock release
    const succeeding = mgr.createWorktree({ prompt: "after-error" })

    const [err, result] = await Promise.all([failing, succeeding])
    expect(err).toBeInstanceOf(Error)
    expect(result.branch).toBeTruthy()

    const stat = await fs.stat(path.join(result.path, ".git"))
    expect(stat.isFile()).toBe(true)
  })

  it("concurrent remove and create on the same repo do not conflict", async () => {
    const root = await createTempRepo()
    const mgr = createManager(root)

    // Create a worktree first
    const wt = await mgr.createWorktree({ prompt: "to-remove" })

    // Concurrently remove and create
    const [, created] = await Promise.all([mgr.removeWorktree(wt.path), mgr.createWorktree({ prompt: "new-one" })])

    expect(created.branch).toBeTruthy()
    const stat = await fs.stat(path.join(created.path, ".git"))
    expect(stat.isFile()).toBe(true)
  })
})
