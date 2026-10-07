import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { STAGED_DIFF_FILE, captureStagedDiff, writeStagedDiff } from "../../src/kilo-provider/staged-diff"

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return Buffer.from(result.stdout)
  throw new Error(Buffer.from(result.stderr).toString("utf8") || Buffer.from(result.stdout).toString("utf8"))
}

async function repo(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-staged-diff-"))
  try {
    git(dir, ["init"])
    git(dir, ["config", "core.autocrlf", "false"])
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("writeStagedDiff", () => {
  it("writes exactly the staged diff and ignores unstaged changes", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "staged.txt"), "before\n")
      await fs.writeFile(path.join(dir, "unstaged.txt"), "before\n")
      git(dir, ["add", "staged.txt", "unstaged.txt"])
      git(dir, ["-c", "user.name=Kilo", "-c", "user.email=kilo@example.com", "commit", "-m", "init"])

      await fs.writeFile(path.join(dir, "staged.txt"), "after\n")
      git(dir, ["add", "staged.txt"])
      await fs.writeFile(path.join(dir, "unstaged.txt"), "dirty\n")

      const result = await writeStagedDiff(dir)
      expect(result).toEqual({ kind: "written", file: STAGED_DIFF_FILE })

      const written = await fs.readFile(path.join(dir, STAGED_DIFF_FILE))
      expect(Buffer.compare(written, git(dir, ["diff", "--staged"]))).toBe(0)
      const text = written.toString("utf8")
      expect(text).toContain("diff --git a/staged.txt b/staged.txt")
      expect(text).toContain("+after")
      expect(text).not.toContain("unstaged.txt")
    })
  })

  it("does not create a file when the index is clean", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "file.txt"), "before\n")
      git(dir, ["add", "file.txt"])
      git(dir, ["-c", "user.name=Kilo", "-c", "user.email=kilo@example.com", "commit", "-m", "init"])
      await fs.writeFile(path.join(dir, "file.txt"), "dirty\n")

      const result = await writeStagedDiff(dir)
      expect(result).toEqual({ kind: "empty" })
      await expect(fs.stat(path.join(dir, STAGED_DIFF_FILE))).rejects.toThrow()
    })
  })

  it("writes staged files on a repository without an initial commit", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "new.txt"), "hello\n")
      git(dir, ["add", "new.txt"])

      const result = await writeStagedDiff(dir)
      expect(result).toEqual({ kind: "written", file: STAGED_DIFF_FILE })
      const text = await fs.readFile(path.join(dir, STAGED_DIFF_FILE), "utf8")
      expect(text).toContain("new file mode")
      expect(text).toContain("+hello")
    })
  })

  it("reports git failures for non-repositories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-staged-diff-nogit-"))
    try {
      await expect(writeStagedDiff(dir)).rejects.toThrow(/not a git repository/i)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("captureStagedDiff", () => {
  it("answers with the written path and with the empty marker", async () => {
    await repo(async (dir) => {
      await fs.writeFile(path.join(dir, "new.txt"), "hello\n")
      git(dir, ["add", "new.txt"])
      const posts: unknown[] = []
      await captureStagedDiff({ requestId: "r1", dir, post: (m) => posts.push(m), error: String })
      expect(posts).toEqual([{ type: "stagedDiffResult", requestId: "r1", path: STAGED_DIFF_FILE }])
    })
    await repo(async (dir) => {
      const posts: unknown[] = []
      await captureStagedDiff({ requestId: "r2", dir, post: (m) => posts.push(m), error: String })
      expect(posts).toEqual([{ type: "stagedDiffResult", requestId: "r2", empty: true }])
    })
  })

  it("answers with a user-facing error for non-repositories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-staged-diff-nogit-"))
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const posts: unknown[] = []
      await captureStagedDiff({
        requestId: "r3",
        dir,
        post: (m) => posts.push(m),
        error: (e) => (e instanceof Error ? e.message : String(e)),
      })
      expect(posts).toEqual([
        { type: "stagedDiffError", requestId: "r3", error: expect.stringMatching(/not a git repository/i) },
      ])
    } finally {
      log.mockRestore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
