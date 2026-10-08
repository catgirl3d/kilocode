import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { interceptMessage } from "../../src/kilo-provider/git-changes-request"

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return Buffer.from(result.stdout).toString("utf8").trim()
  throw new Error(Buffer.from(result.stderr).toString("utf8") || Buffer.from(result.stdout).toString("utf8"))
}

async function repo(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-git-commits-"))
  try {
    git(dir, ["init"])
    git(dir, ["config", "core.autocrlf", "false"])
    git(dir, ["config", "user.name", "Kilo"])
    git(dir, ["config", "user.email", "kilo@example.com"])
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("git commit mention requests", () => {
  it("preserves the existing git-changes context request", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "working.txt"), "before\n")
      git(dir, ["add", "working.txt"])
      git(dir, ["commit", "-m", "base"])
      await fs.writeFile(path.join(dir, "working.txt"), "after\n")
      const messages: unknown[] = []

      const result = await interceptMessage(
        { type: "requestGitChangesContext", requestId: "changes-1", sessionID: "session-1" },
        { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
      )

      expect(result).toBeNull()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "gitChangesContextResult",
        requestId: "changes-1",
        content: expect.stringContaining("+after"),
      })
    })
  })

  it("returns newest commits first for an empty query", async () => {
    await repo(async (dir) => {
      const file = path.join(dir, "history.txt")
      await fs.writeFile(file, "base\n")
      git(dir, ["add", "history.txt"])
      git(dir, ["commit", "-m", "base"])
      const baseHash = git(dir, ["rev-parse", "HEAD"])
      await fs.writeFile(file, "base\nsecond\n")
      git(dir, ["add", "history.txt"])
      git(dir, ["commit", "-m", "second"])
      const secondHash = git(dir, ["rev-parse", "HEAD"])
      const messages: unknown[] = []

      const result = await interceptMessage(
        { type: "requestGitCommits", requestId: "empty-query-1", query: "" },
        { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
      )

      expect(result).toBeNull()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ type: "gitCommitsResult", requestId: "empty-query-1" })
      const commits = (messages[0] as { commits: Array<{ hash: string; subject: string }> }).commits
      expect(commits.slice(0, 2)).toMatchObject([
        { hash: secondHash, subject: "second" },
        { hash: baseHash, subject: "base" },
      ])
    })
  })

  it("returns an empty commit list for a directory outside a git repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-no-git-commits-"))
    try {
      const messages: unknown[] = []
      const result = await interceptMessage(
        { type: "requestGitCommits", requestId: "no-repo-1", query: "anything" },
        { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
      )

      expect(result).toBeNull()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "gitCommitsResult",
        requestId: "no-repo-1",
        commits: [],
      })
      expect(messages[0]).not.toHaveProperty("error")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("searches commit messages and abbreviated hashes in the requested session directory", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "history.txt"), "first\n")
      git(dir, ["add", "history.txt"])
      git(dir, ["commit", "-m", "restore commit picker search"])
      const hash = git(dir, ["rev-parse", "HEAD"])
      const calls: Array<string | undefined> = []
      const messages: unknown[] = []
      const ctx = {
        workspaceDir: (sessionID?: string) => {
          calls.push(sessionID)
          return dir
        },
        post: (message: unknown) => messages.push(message),
        error: String,
      }

      const result = await interceptMessage(
        { type: "requestGitCommits", requestId: "search-1", query: "picker search", sessionID: "session-1" },
        ctx,
      )

      expect(result).toBeNull()
      expect(calls).toEqual(["session-1"])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "gitCommitsResult",
        requestId: "search-1",
        commits: [{ hash, shortHash: hash.slice(0, 7), subject: "restore commit picker search", author: "Kilo" }],
      })

      messages.length = 0
      await interceptMessage(
        { type: "requestGitCommits", requestId: "search-2", query: hash.slice(0, 8), sessionID: "session-1" },
        ctx,
      )
      expect(messages[0]).toMatchObject({ type: "gitCommitsResult", requestId: "search-2", commits: [{ hash }] })
    })
  })

  it("returns the commit header, changed-file summary and patch for a full hash", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "change.txt"), "before\n")
      git(dir, ["add", "change.txt"])
      git(dir, ["commit", "-m", "base"])
      await fs.writeFile(path.join(dir, "change.txt"), "after\n")
      git(dir, ["add", "change.txt"])
      git(dir, ["commit", "-m", "selected commit details"])
      const hash = git(dir, ["rev-parse", "HEAD"])
      const messages: unknown[] = []

      const result = await interceptMessage(
        { type: "requestGitCommitContext", requestId: "show-1", hash, sessionID: "session-2" },
        { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
      )

      expect(result).toBeNull()
      expect(messages).toHaveLength(1)
      const response = messages[0] as { type: string; requestId: string; hash: string; content: string }
      expect(response.type).toBe("gitCommitContextResult")
      expect(response.requestId).toBe("show-1")
      expect(response.hash).toBe(hash)
      const content = response.content
      expect(typeof content).toBe("string")
      expect(content.includes("Message: selected commit details")).toBe(true)
      expect(content.includes("change.txt")).toBe(true)
      expect(content.includes("+after")).toBe(true)
    })
  })

  it("returns a host error instead of attaching an invalid commit reference", async () => {
    await repo(async (dir) => {
      const messages: unknown[] = []
      const log = spyOn(console, "error").mockImplementation(() => {})
      let result: unknown
      try {
        result = await interceptMessage(
          { type: "requestGitCommitContext", requestId: "show-invalid", hash: "not-a-hash" },
          { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
        )
      } finally {
        log.mockRestore()
      }

      expect(result).toBeNull()
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "gitCommitContextError",
        requestId: "show-invalid",
        hash: "not-a-hash",
        error: "Error: Invalid commit hash",
      })
    })
  })

  it("caps the assembled commit content at the output limit", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "big.txt"), ("x".repeat(200) + "\n").repeat(3000))
      git(dir, ["add", "big.txt"])
      git(dir, ["commit", "-m", "big commit"])
      const hash = git(dir, ["rev-parse", "HEAD"])
      const messages: unknown[] = []

      await interceptMessage(
        { type: "requestGitCommitContext", requestId: "show-big", hash },
        { workspaceDir: () => dir, post: (message) => messages.push(message), error: String },
      )

      const content = (messages[0] as { content: string }).content
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
        400_000 + Buffer.byteLength("\n\nOutput truncated."),
      )
      expect(content.includes("Output truncated.")).toBe(true)
    })
  })

  it("leaves unrelated file search requests on their existing route", async () => {
    const message = { type: "requestFileSearch", requestId: "search-files-1", query: "src" }
    const result = await interceptMessage(message, {
      workspaceDir: () => "/workspace",
      post: () => {},
      error: String,
    })
    expect(result).toBe(message)
  })
})
