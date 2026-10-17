import { describe, expect, it, setDefaultTimeout } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
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

async function repo(prefix = "kilo-session-files-repo-"): Promise<string> {
  const root = await folder(prefix)
  git(root, "init", "--quiet")
  git(root, "branch", "-M", "main")
  git(root, "config", "user.email", "test@example.invalid")
  git(root, "config", "user.name", "Kilo Test")
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\nignored-dir/\n")
  git(root, "add", ".gitignore")
  git(root, "commit", "--quiet", "-m", "init")
  await fs.writeFile(path.join(root, "base-only.txt"), "base\n")
  git(root, "add", "base-only.txt")
  git(root, "commit", "--quiet", "-m", "base")
  return root
}

async function baseBranchRepo(): Promise<string> {
  const root = await repo()
  git(root, "checkout", "-b", "feature")
  return root
}

function manager(root: string, parentBranch: string | undefined, ids: string[]): WorktreeStateManager {
  return {
    getWorktree: () => ({ id: worktreeId, path: root, parentBranch }),
    getSessions: () => ids.map((id) => ({ id, worktreeId, createdAt: "2026-01-01T00:00:00.000Z" })),
    getActiveTarget: () => undefined,
  } as unknown as WorktreeStateManager
}

function client(responses: Record<string, string[] | Error>, calls: string[]): KiloClient {
  return {
    session: {
      files: async ({ sessionID }: { sessionID: string }) => {
        calls.push(sessionID)
        const response = responses[sessionID]
        if (response instanceof Error) throw response
        return { data: { files: response ?? [] } }
      },
    },
  } as unknown as KiloClient
}

async function request(
  root: string,
  ids: string[],
  responses: Record<string, string[] | Error>,
  parentBranch?: string,
): Promise<{ calls: string[]; message: AgentManagerOutMessage | undefined }> {
  const calls: string[] = []
  const messages: AgentManagerOutMessage[] = []
  const deps: Deps = {
    state: manager(root, parentBranch, ids),
    root,
    client: () => client(responses, calls),
    projectId: "project-1",
    post: (message) => messages.push(message),
    log: () => undefined,
  }
  await handleSessionFiles({ type: "agentManager.requestSessionFiles", worktreeId }, deps)
  return { calls, message: messages.at(-1) }
}

describe.serial("requestSessionFiles", () => {
  it("unions every unique session in order and posts sorted files", async () => {
    const root = await repo()
    const result = await request(root, ["session-a", "session-b", "session-a"], {
      "session-a": ["z.txt", "shared.txt"],
      "session-b": ["a.txt", "shared.txt"],
    })

    expect(result.calls).toEqual(["session-a", "session-b"])
    expect(result.message).toMatchObject({
      type: "agentManager.sessionFiles",
      worktreeId,
      files: ["a.txt", "shared.txt", "z.txt"],
    })
    expect(result.message).not.toHaveProperty("note")
    expect(result.message).not.toHaveProperty("error")
  })

  it("keeps successful session files and reports a partial session note", async () => {
    const root = await repo()
    const result = await request(root, ["session-ok", "session-failed"], {
      "session-ok": ["kept.txt"],
      "session-failed": new Error("backend unavailable"),
    })

    expect(result.message).toMatchObject({ files: ["kept.txt"] })
    expect(result.message).toHaveProperty("note")
    expect(result.message).not.toHaveProperty("error")
  })

  it("keeps git files when every session request fails", async () => {
    const root = await repo()
    await fs.writeFile(path.join(root, "worktree.txt"), "new\n")
    const result = await request(root, ["session-a", "session-b"], {
      "session-a": new Error("first failure"),
      "session-b": new Error("second failure"),
    })

    expect(result.message).toMatchObject({ files: ["worktree.txt"] })
    expect(result.message).toHaveProperty("note")
    expect(result.message).not.toHaveProperty("error")
  })

  it("posts an error when every source fails", async () => {
    const parent = await folder("kilo-session-files-missing-")
    const missing = path.join(parent, "missing-worktree")
    const result = await request(missing, ["session-a"], { "session-a": new Error("session failure") }, "main")

    expect(result.message).toMatchObject({ files: [] })
    expect(result.message).toHaveProperty("error")
    expect(result.message).not.toHaveProperty("note")
  })

  it("includes untracked files but omits ignored files and parses a spaced rename pair", async () => {
    const root = await repo()
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n")
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored\n")
    await fs.writeFile(path.join(root, "xy file.txt"), "rename\n")
    git(root, "add", "xy file.txt")
    git(root, "commit", "--quiet", "-m", "rename source")
    git(root, "mv", "xy file.txt", "renamed.txt")

    const result = await request(root, [], {})
    const message = result.message
    expect(message).toMatchObject({ files: ["renamed.txt", "untracked.txt", "xy file.txt"] })
    expect(message).not.toHaveProperty("error")
    expect(message).not.toHaveProperty("note")
  })

  it("preserves significant spaces in worktree paths", async () => {
    const root = await repo()
    await fs.writeFile(path.join(root, " leading.txt"), "leading\n")
    await fs.writeFile(path.join(root, "trailing.txt "), "trailing\n")

    const result = await request(root, [], {})
    expect(result.message).toMatchObject({ files: [" leading.txt", "trailing.txt "] })
  })

  it("lists branch commits without listing files that only exist on the base", async () => {
    const root = await baseBranchRepo()
    await fs.writeFile(path.join(root, "branch-only.txt"), "feature\n")
    git(root, "add", "branch-only.txt")
    git(root, "commit", "--quiet", "-m", "feature")

    const result = await request(root, [], {}, "main")
    expect(result.message).toMatchObject({ files: ["branch-only.txt"] })
    expect(result.message).not.toHaveProperty("note")
  })

  it("skips committed files when the base branch was rewritten", async () => {
    const root = await baseBranchRepo()
    await fs.writeFile(path.join(root, "branch-only.txt"), "feature\n")
    git(root, "add", "branch-only.txt")
    git(root, "commit", "--quiet", "-m", "feature")
    git(root, "checkout", "main")
    await fs.writeFile(path.join(root, "base-rewritten.txt"), "rewritten\n")
    git(root, "add", ".")
    git(root, "commit", "--quiet", "--amend", "--no-edit")
    git(root, "checkout", "feature")

    const result = await request(root, [], {}, "main")
    expect(result.message).toMatchObject({ files: [] })
    expect(result.message).toHaveProperty(
      "note",
      "The worktree branch does not contain its base branch; committed files were skipped — the list may be incomplete.",
    )
    expect(result.message).not.toHaveProperty("error")
  })

  it("does not pollute a merged branch with files from the merged base layer", async () => {
    const root = await baseBranchRepo()
    await fs.writeFile(path.join(root, "branch-only.txt"), "feature\n")
    git(root, "add", "branch-only.txt")
    git(root, "commit", "--quiet", "-m", "feature")
    git(root, "checkout", "main")
    await fs.writeFile(path.join(root, "base-updated.txt"), "updated\n")
    git(root, "add", ".")
    git(root, "commit", "--quiet", "--amend", "--no-edit")
    git(root, "checkout", "feature")
    git(root, "merge", "--quiet", "--no-edit", "main")

    const result = await request(root, [], {}, "main")
    expect(result.message).toMatchObject({ files: ["branch-only.txt"] })
    expect(result.message).not.toHaveProperty("note")
  })

  it("skips committed files when the branch is behind an advanced base", async () => {
    const root = await baseBranchRepo()
    await fs.writeFile(path.join(root, "branch-only.txt"), "feature\n")
    git(root, "add", "branch-only.txt")
    git(root, "commit", "--quiet", "-m", "feature")
    git(root, "checkout", "main")
    await fs.writeFile(path.join(root, "base-advanced.txt"), "advanced\n")
    git(root, "add", "base-advanced.txt")
    git(root, "commit", "--quiet", "-m", "base advance")
    git(root, "checkout", "feature")

    const result = await request(root, [], {}, "main")
    expect(result.message).toMatchObject({ files: [] })
    expect(result.message).toHaveProperty(
      "note",
      "The worktree branch does not contain its base branch; committed files were skipped — the list may be incomplete.",
    )
  })
})

describe.serial("copySessionFiles apply guard", () => {
  it("refuses to copy while the worktree has an unresolved rebase", async () => {
    const worktree = await repo("kilo-session-files-rebase-")
    git(worktree, "checkout", "-b", "feature")
    await fs.writeFile(path.join(worktree, "base-only.txt"), "feature\n")
    git(worktree, "add", "base-only.txt")
    git(worktree, "commit", "--quiet", "-m", "feature")
    git(worktree, "checkout", "main")
    await fs.writeFile(path.join(worktree, "base-only.txt"), "main\n")
    git(worktree, "add", "base-only.txt")
    git(worktree, "commit", "--quiet", "-m", "main")
    git(worktree, "checkout", "feature")
    expect(() => git(worktree, "rebase", "main")).toThrow()

    const local = await folder("kilo-session-files-local-")
    await fs.writeFile(path.join(local, "base-only.txt"), "local\n")
    const messages: AgentManagerOutMessage[] = []
    const deps: Deps = {
      state: manager(worktree, undefined, []),
      root: local,
      client: () => ({}) as KiloClient,
      projectId: "project-1",
      post: (message) => messages.push(message),
      log: () => undefined,
    }

    await handleSessionFiles(
      { type: "agentManager.copySessionFiles", worktreeId, files: ["base-only.txt"], force: true } satisfies Apply,
      deps,
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
