import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { handleSessionFiles } from "../../src/agent-manager/session-files-controller"
import type { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import type { AgentManagerOutMessage, AgentManagerInMessage } from "../../src/agent-manager/types"

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
const temp = path.join(os.tmpdir(), "kilo")
const worktreeId = "worktree-1"
setDefaultTimeout(15_000)

type Apply = Extract<AgentManagerInMessage, { type: "agentManager.copySessionFiles" }>
type Deps = Parameters<typeof handleSessionFiles>[1]

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env, windowsHide: true })
}

async function folder(prefix: string): Promise<string> {
  await fs.mkdir(temp, { recursive: true })
  return await fs.mkdtemp(path.join(temp, prefix))
}

async function commit(root: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(root, file), text)
  git(root, "add", ".")
  git(root, "commit", "--quiet", "-m", message)
}

async function repo(prefix = "kilo-session-files-repo-"): Promise<string> {
  const root = await folder(prefix)
  git(root, "init", "--quiet")
  git(root, "branch", "-M", "main")
  git(root, "config", "user.email", "test@example.invalid")
  git(root, "config", "user.name", "Kilo Test")
  await commit(root, { ".gitignore": "ignored.txt\nignored-dir/\n" }, "init")
  await commit(root, { "base-only.txt": "base\n" }, "base")
  return root
}

async function branched(): Promise<string> {
  const root = await repo()
  git(root, "checkout", "--quiet", "-b", "feature")
  await commit(root, { "branch-only.txt": "feature\n" }, "feature")
  return root
}

async function onMain(root: string, change: () => Promise<void>): Promise<void> {
  git(root, "checkout", "--quiet", "main")
  await change()
  git(root, "checkout", "--quiet", "feature")
}

function manager(root: string, parentBranch: string | undefined, remote?: string): WorktreeStateManager {
  return {
    getWorktree: () => ({ id: worktreeId, path: root, parentBranch, remote }),
  } as unknown as WorktreeStateManager
}

function deps(worktree: string, root: string | undefined, messages: AgentManagerOutMessage[], remote?: string): Deps {
  return {
    state: manager(worktree, "main", remote),
    root,
    projectId: "project-1",
    post: (message) => messages.push(message),
    log: () => undefined,
  }
}

async function request(root: string, remote?: string): Promise<AgentManagerOutMessage | undefined> {
  const messages: AgentManagerOutMessage[] = []
  await handleSessionFiles({ type: "agentManager.requestSessionFiles", worktreeId }, deps(root, root, messages, remote))
  return messages.at(-1)
}

describe.serial("requestSessionFiles", () => {
  it("lists committed, uncommitted, deleted, renamed and untracked branch work", async () => {
    const root = await repo()
    await commit(root, { "keep.txt": "keep\n", "old.txt": "old\n", "gone.txt": "gone\n", "edit.txt": "edit\n" }, "more")
    git(root, "checkout", "--quiet", "-b", "feature")
    await fs.appendFile(path.join(root, "edit.txt"), "changed\n")
    git(root, "rm", "--quiet", "gone.txt")
    git(root, "mv", "old.txt", "renamed file.txt")
    await commit(root, { "agent.txt": "agent\n" }, "agent")
    await commit(root, { "temporary.txt": "temporary\n" }, "add temporary")
    git(root, "rm", "--quiet", "temporary.txt")
    git(root, "commit", "--quiet", "-m", "remove temporary")
    await fs.rm(path.join(root, "keep.txt"))
    await fs.writeFile(path.join(root, " leading.txt"), "untracked\n")
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored\n")

    expect(await request(root)).toEqual({
      type: "agentManager.sessionFiles",
      projectId: "project-1",
      worktreeId,
      files: [" leading.txt", "agent.txt", "edit.txt", "gone.txt", "keep.txt", "old.txt", "renamed file.txt"],
    })
  })

  it("lists only branch work after the base branch advances", async () => {
    const root = await branched()
    await onMain(root, () => commit(root, { "base-advanced.txt": "advanced\n" }, "advance"))

    expect(await request(root)).toMatchObject({ files: ["branch-only.txt"] })
  })

  it("lists only branch work after the base branch is rewritten", async () => {
    const root = await branched()
    await onMain(root, async () => {
      await fs.writeFile(path.join(root, "base-rewritten.txt"), "rewritten\n")
      git(root, "add", ".")
      git(root, "commit", "--quiet", "--amend", "--no-edit")
    })

    const message = await request(root)
    expect(message).toMatchObject({ files: ["branch-only.txt"] })
    expect(message).not.toHaveProperty("error")
  })

  it("lists only branch work after the base branch is merged into it", async () => {
    const root = await branched()
    await onMain(root, () => commit(root, { "base-updated.txt": "updated\n" }, "update"))
    git(root, "merge", "--quiet", "--no-edit", "main")

    expect(await request(root)).toMatchObject({ files: ["branch-only.txt"] })
  })

  it("uses the remote base when the local base branch does not exist", async () => {
    const root = await branched()
    git(root, "update-ref", "refs/remotes/origin/main", "main")
    git(root, "branch", "--quiet", "-m", "main", "trunk")

    expect(await request(root, "origin")).toMatchObject({ files: ["branch-only.txt"] })
  })

  it("posts an error instead of guessing when git no longer knows the fork point", async () => {
    const root = await branched()
    await onMain(root, async () => {
      await fs.writeFile(path.join(root, "base-rewritten.txt"), "rewritten\n")
      git(root, "add", ".")
      git(root, "commit", "--quiet", "--amend", "--no-edit")
    })
    git(root, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all")

    expect(await request(root)).toMatchObject({
      files: [],
      error: "Could not find where this worktree branched from main; use Branch diff instead.",
    })
  })

  it("posts an error when the worktree directory is missing", async () => {
    const parent = await folder("kilo-session-files-missing-")

    expect(await request(path.join(parent, "missing-worktree"))).toMatchObject({
      files: [],
      error: "Worktree directory not found",
    })
  })
})

describe.serial("copySessionFiles apply guard", () => {
  it("reports files the local branch also changed until the user overwrites them", async () => {
    const root = await repo()
    await commit(root, { "shared.txt": "base\n" }, "shared")
    const worktree = path.join(await folder("kilo-session-files-worktree-"), "wt")
    git(root, "worktree", "add", "--quiet", "-b", "feature", worktree)
    await commit(worktree, { "shared.txt": "agent\n", "agent.txt": "agent\n" }, "agent")
    await commit(root, { "shared.txt": "local\n" }, "local")
    const files = ["agent.txt", "shared.txt"]

    const messages: AgentManagerOutMessage[] = []
    await handleSessionFiles(
      { type: "agentManager.copySessionFiles", worktreeId, files } satisfies Apply,
      deps(worktree, root, messages),
    )

    expect(messages.at(-1)).toMatchObject({
      status: "conflict",
      conflicts: [{ file: "shared.txt", reason: "changed on local branch" }],
    })
    expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("local\n")
    await expect(fs.stat(path.join(root, "agent.txt"))).rejects.toThrow()

    await handleSessionFiles(
      { type: "agentManager.copySessionFiles", worktreeId, files, force: true } satisfies Apply,
      deps(worktree, root, messages),
    )

    expect(messages.at(-1)).toMatchObject({ status: "success" })
    expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("agent\n")
    expect(await fs.readFile(path.join(root, "agent.txt"), "utf8")).toBe("agent\n")
  })

  it("refuses to copy while the worktree has an unresolved rebase", async () => {
    const worktree = await repo("kilo-session-files-rebase-")
    git(worktree, "checkout", "--quiet", "-b", "feature")
    await commit(worktree, { "base-only.txt": "feature\n" }, "feature")
    git(worktree, "checkout", "--quiet", "main")
    await commit(worktree, { "base-only.txt": "main\n" }, "main")
    git(worktree, "checkout", "--quiet", "feature")
    expect(() => git(worktree, "rebase", "main")).toThrow()

    const local = await folder("kilo-session-files-local-")
    await fs.writeFile(path.join(local, "base-only.txt"), "local\n")
    const messages: AgentManagerOutMessage[] = []

    await handleSessionFiles(
      { type: "agentManager.copySessionFiles", worktreeId, files: ["base-only.txt"], force: true } satisfies Apply,
      deps(worktree, local, messages),
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: "agentManager.applyWorktreeDiffResult",
      status: "error",
      message: "The worktree has an in-progress merge or rebase; finish it before copying files.",
    })
    expect(await fs.readFile(path.join(local, "base-only.txt"), "utf8")).toBe("local\n")
  })
})
