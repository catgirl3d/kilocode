// fork_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { AgentManagerInMessage, AgentManagerOutMessage } from "./types"
import type { WorktreeStateManager } from "./WorktreeStateManager"
import { exec } from "../util/process"
import { copy, dirty, normalize, statusFiles } from "./copy-session-files"

type Request = Extract<AgentManagerInMessage, { type: "agentManager.requestSessionFiles" }>
type Apply = Extract<AgentManagerInMessage, { type: "agentManager.copySessionFiles" }>

interface Deps {
  state: WorktreeStateManager | undefined
  root: string | undefined
  client: () => KiloClient
  projectId: string | undefined
  post: (message: AgentManagerOutMessage) => void
  log: (...args: unknown[]) => void
}

function error(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// fork_change start - changed-files source helpers
function code(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = (error as { code?: unknown }).code
  if (typeof value === "string" || typeof value === "number") return value
  return undefined
}

function names(stdout: string): Set<string> {
  return new Set(stdout.split("\0").filter(Boolean).map(normalize))
}

async function oid(dir: string, ref: string): Promise<string | undefined> {
  try {
    const result = await exec("git", ["rev-parse", "--verify", ref], { cwd: dir })
    const value = result.stdout.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function ancestor(dir: string, base: string, head: string): Promise<"yes" | "stale"> {
  try {
    await exec("git", ["merge-base", "--is-ancestor", base, head], { cwd: dir })
    return "yes"
  } catch (err) {
    if (code(err) === 1) return "stale"
    throw err
  }
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
// fork_change end

function target(id: string, deps: Deps) {
  const state = deps.state
  const worktree = state?.getWorktree(id)
  if (!state || !worktree) throw new Error("Worktree not found")
  return { state, worktree }
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
  try {
    const { state, worktree } = target(input.worktreeId, deps)
    const files = new Set<string>()
    const notes: string[] = []
    const succeeded = new Set<string>()
    const sessions = [...new Set(state.getSessions(input.worktreeId).map((item) => item.id))]
    const failed: string[] = []

    // fork_change start - sequential session source
    for (const id of sessions) {
      try {
        const response = await deps
          .client()
          .session.files({ sessionID: id, directory: worktree.path }, { throwOnError: true })
        for (const file of response.data.files) files.add(normalize(file))
      } catch (err) {
        failed.push(`Could not list session files for ${id}: ${error(err)}; the list may be incomplete.`)
      }
    }
    if (sessions.length > 0 && failed.length < sessions.length) succeeded.add("sessions")
    notes.push(...failed)
    // fork_change end

    // fork_change start - worktree status source
    try {
      const response = await exec("git", ["status", "--porcelain", "--untracked-files=all", "-z", "--"], {
        cwd: worktree.path,
        maxBuffer: 4 * 1024 * 1024,
      })
      for (const file of statusFiles(response.stdout)) files.add(file)
      succeeded.add("status")
    } catch (err) {
      notes.push(`Could not read worktree status: ${error(err)}; the list may be incomplete.`)
    }
    // fork_change end

    // fork_change start - gated committed source
    const parent = worktree.parentBranch
    if (parent !== undefined) {
      const base = await oid(worktree.path, parent)
      const head = await oid(worktree.path, "HEAD")
      if (!base || !head) {
        notes.push("Could not resolve the base branch or HEAD; committed files were skipped.")
      } else {
        try {
          const gate = await ancestor(worktree.path, base, head)
          if (gate === "stale") {
            notes.push(
              "The worktree branch does not contain its base branch; committed files were skipped — the list may be incomplete.",
            )
          } else {
            const response = await exec("git", ["diff", "--name-only", "-z", "--no-renames", base, head, "--"], {
              cwd: worktree.path,
              maxBuffer: 4 * 1024 * 1024,
            })
            for (const file of names(response.stdout)) files.add(file)
            succeeded.add("committed")
          }
        } catch (err) {
          notes.push(`Could not list committed files: ${error(err)}; the list may be incomplete.`)
        }
      }
    }
    // fork_change end

    if (succeeded.size === 0) {
      const message = notes.join(" ") || "Could not list changed files."
      deps.post({
        type: "agentManager.sessionFiles",
        projectId: deps.projectId,
        worktreeId: input.worktreeId,
        files: [],
        error: message,
      })
      return
    }

    deps.post({
      type: "agentManager.sessionFiles",
      projectId: deps.projectId,
      worktreeId: input.worktreeId,
      files: [...files].sort(),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    })
  } catch (err) {
    const message = error(err)
    deps.log("Failed to list session files:", message)
    deps.post({
      type: "agentManager.sessionFiles",
      projectId: deps.projectId,
      worktreeId: input.worktreeId,
      files: [],
      error: message,
    })
  }
}

async function apply(input: Apply, deps: Deps): Promise<void> {
  try {
    const { worktree } = target(input.worktreeId, deps)
    if (!deps.root) {
      result(input, deps, "error", "Open a git repository to apply changes")
      return
    }
    // fork_change start - refuse copies during merge or rebase
    if (await operation(worktree.path)) {
      result(input, deps, "error", "The worktree has an in-progress merge or rebase; finish it before copying files.")
      return
    }
    // fork_change end
    result(input, deps, "checking", "Checking local changes...")
    if (!input.force) {
      const conflicts = await dirty(deps.root, input.files)
      if (conflicts.length > 0) {
        result(
          input,
          deps,
          "conflict",
          "Local changes would be overwritten. Choose Overwrite to replace them.",
          conflicts,
        )
        return
      }
    }

    result(input, deps, "applying", "Copying session files to local branch...")
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
    deps.log("Failed to copy session files:", message)
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
