import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { interceptMessage } from "../../src/kilo-provider/git-changes-request"
import { STAGED_DIFF_FILE } from "../../src/kilo-provider/staged-diff"

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return Buffer.from(result.stdout)
  throw new Error(Buffer.from(result.stderr).toString("utf8") || Buffer.from(result.stdout).toString("utf8"))
}

async function repo(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-staged-diff-interceptor-"))
  try {
    git(dir, ["init"])
    git(dir, ["config", "core.autocrlf", "false"])
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("staged diff message interception", () => {
  it("writes the staged diff in the session directory and answers the webview", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "new.txt"), "hello\n")
      git(dir, ["add", "new.txt"])

      const messages: unknown[] = []
      const dirs: Array<string | undefined> = []
      const result = await interceptMessage(
        { type: "requestStagedDiff", requestId: "r1", sessionID: "s1" },
        {
          workspaceDir: (sessionID) => {
            dirs.push(sessionID)
            return dir
          },
          post: (message) => messages.push(message),
          error: String,
        },
      )

      expect(result).toBeNull()
      expect(dirs).toEqual(["s1"])
      expect(messages).toEqual([{ type: "stagedDiffResult", requestId: "r1", path: STAGED_DIFF_FILE }])
      expect(await fs.readFile(path.join(dir, STAGED_DIFF_FILE), "utf8")).toContain("+hello")
    })
  })

  it("answers with a user-facing error when git fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-staged-diff-interceptor-nogit-"))
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const messages: unknown[] = []
      const result = await interceptMessage(
        { type: "requestStagedDiff", requestId: "r2" },
        {
          workspaceDir: () => dir,
          post: (message) => messages.push(message),
          error: (e) => (e instanceof Error ? e.message : String(e)),
        },
      )

      expect(result).toBeNull()
      expect(messages).toEqual([
        { type: "stagedDiffError", requestId: "r2", error: expect.stringMatching(/not a git repository/i) },
      ])
    } finally {
      log.mockRestore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("leaves unrelated messages untouched", async () => {
    const message = { type: "requestFileSearch", requestId: "r3", query: "a" }
    const result = await interceptMessage(message, {
      workspaceDir: () => "/workspace",
      post: () => {},
      error: String,
    })
    expect(result).toBe(message)
  })
})
