// fork_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { AgentManagerInMessage, AgentManagerOutMessage } from "./types"
import { remoteRef, type Worktree, type WorktreeStateManager } from "./WorktreeStateManager"
import { exec } from "../util/process"
import { copy, dirty, normalize } from "./copy-session-files"

type Request = Extract<AgentManagerInMessage, { type: "agentManager.requestSessionFiles" }>
type Apply = Extract<AgentManagerInMessage, { type: "agentManager.copySessionFiles" }>

interface Deps {
  state: WorktreeStateManager | undefined
  root: string | undefined
  projectId: string | undefined
  post: (message: AgentManagerOutMessage) => void
  log: (...args: unknown[]) => void
}

const buffer = 4 * 1024 * 1024

function error(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function code(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = (error as { code?: unknown }).code
  if (typeof value === "string" || typeof value === "number") return value
  return undefined
}

function names(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map(normalize)
}

function missing(worktree: Worktree): string {
  return `Could not find where this worktree branched from ${worktree.parentBranch}; use Branch diff instead.`
}

async function oid(dir: string, ref: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir })
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function ancestor(dir: string, base: string): Promise<boolean> {
  try {
    await exec("git", ["merge-base", "--is-ancestor", base, "HEAD"], { cwd: dir })
    return true
  } catch {
    return false
  }
}

async function fork(dir: string, ref: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["merge-base", "--fork-point", ref, "HEAD"], { cwd: dir })
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

// Where the worktree branch left its base: the base tip while HEAD still contains it, otherwise
// git's fork point, which finds the old tip in the base reflog after the base was rebased or
// force-pushed. A plain merge-base is never used: after a rewrite it reaches below the old base
// commits and would list them as branch work.
async function start(worktree: Worktree): Promise<string | undefined> {
  // The remote base is only a stand-in for a local base branch that does not exist; trying it after
  // the local branch failed would accept a stale remote tip as the fork point.
  const local = worktree.parentBranch ? await oid(worktree.path, worktree.parentBranch) : undefined
  const ref = local ? worktree.parentBranch : remoteRef(worktree)
  const base = local ?? (worktree.remote ? await oid(worktree.path, ref) : undefined)
  if (!base) return undefined
  if (await ancestor(worktree.path, base)) return base
  return await fork(worktree.path, ref)
}

// Branch work since the fork point: committed, staged and unstaged changes against the working
// tree, deletions included, plus untracked files. Renames are split into a delete and an add.
async function changed(dir: string, from: string): Promise<string[]> {
  const diff = await exec("git", ["diff", "--name-only", "-z", "--no-renames", from, "--"], {
    cwd: dir,
    maxBuffer: buffer,
  })
  const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: dir,
    maxBuffer: buffer,
  })
  return [...new Set([...names(diff.stdout), ...names(untracked.stdout)])].sort()
}

// Files the local branch committed since the fork point. Copying the worktree version over them
// would silently drop those commits, which the uncommitted-changes check cannot see.
async function overlap(root: string, from: string, files: string[]): Promise<{ file: string; reason: string }[]> {
  const diff = await exec("git", ["-C", root, "diff", "--name-only", "-z", "--no-renames", from, "HEAD", "--"], {
    maxBuffer: buffer,
  })
  const local = new Set(names(diff.stdout))
  return [...new Set(files.map(normalize))]
    .filter((file) => local.has(file))
    .map((file) => ({ file, reason: "changed on local branch" }))
}

async function exists(dir: string, value: string): Promise<boolean> {
  const target = path.isAbsolute(value) ? value : path.resolve(dir, value)
  try {
    await fs.stat(target)
    return true
  } catch (err) {
    if (code(err) === "ENOENT") return false
    throw err
  }
}

async function operation(dir: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    const result = await exec("git", ["rev-parse", "--git-path", name], { cwd: dir })
    const value = result.stdout.trim()
    if (value && (await exists(dir, value))) return true
  }
  return false
}

function target(id: string, deps: Deps): Worktree {
  const worktree = deps.state?.getWorktree(id)
  if (!worktree) throw new Error("Worktree not found")
  return worktree
}

function result(
  input: Apply,
  deps: Deps,
  status: "checking" | "applying" | "success" | "conflict" | "error",
  message: string,
  conflicts?: { file: string; reason: string }[],
): void {
  deps.post({
    type: "agentManager.applyWorktreeDiffResult",
    projectId: deps.projectId,
    worktreeId: input.worktreeId,
    status,
    message,
    conflicts,
  })
}

async function request(input: Request, deps: Deps): Promise<void> {
  const post = (files: string[], error?: string) =>
    deps.post({
      type: "agentManager.sessionFiles",
      projectId: deps.projectId,
      worktreeId: input.worktreeId,
      files,
      ...(error ? { error } : {}),
    })
  try {
    const worktree = target(input.worktreeId, deps)
    const dir = await fs.stat(worktree.path).catch(() => undefined)
    if (!dir?.isDirectory()) {
      post([], "Worktree directory not found")
      return
    }
    const from = await start(worktree)
    if (!from) {
      post([], missing(worktree))
      return
    }
    post(await changed(worktree.path, from))
  } catch (err) {
    const message = error(err)
    deps.log("Failed to list changed files:", message)
    post([], message)
  }
}

async function apply(input: Apply, deps: Deps): Promise<void> {
  try {
    const worktree = target(input.worktreeId, deps)
    if (!deps.root) {
      result(input, deps, "error", "Open a git repository to apply changes")
      return
    }
    if (await operation(worktree.path)) {
      result(input, deps, "error", "The worktree has an in-progress merge or rebase; finish it before copying files.")
      return
    }
    result(input, deps, "checking", "Checking local changes...")
    if (!input.force) {
      const from = await start(worktree)
      if (!from) {
        result(input, deps, "error", missing(worktree))
        return
      }
      const conflicts = [...(await dirty(deps.root, input.files)), ...(await overlap(deps.root, from, input.files))]
      if (conflicts.length > 0) {
        result(
          input,
          deps,
          "conflict",
          "These files also changed locally. Choose Overwrite to replace them.",
          conflicts,
        )
        return
      }
    }

    result(input, deps, "applying", "Copying changed files to local branch...")
    const copied = await copy({ worktreePath: worktree.path, root: deps.root, files: input.files })
    if (copied.error) {
      result(input, deps, "error", copied.error)
      return
    }
    if (copied.failed.length > 0) {
      const names = copied.failed
        .slice(0, 3)
        .map((item) => item.file)
        .join(", ")
      const rest = copied.failed.length > 3 ? `, and ${copied.failed.length - 3} more` : ""
      result(input, deps, "error", `Failed to copy ${names}${rest}: ${copied.failed[0]?.message ?? "unknown error"}`)
      return
    }
    result(input, deps, "success", `Copied ${copied.applied} files (${copied.removed} removed)`)
  } catch (err) {
    const message = error(err)
    deps.log("Failed to copy changed files:", message)
    result(input, deps, "error", message)
  }
}

export async function handleSessionFiles(input: Request | Apply, deps: Deps): Promise<boolean> {
  if (input.type === "agentManager.requestSessionFiles") {
    await request(input, deps)
    return true
  }
  await apply(input, deps)
  return true
}
