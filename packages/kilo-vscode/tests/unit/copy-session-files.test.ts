import { describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { copy, dirty } from "../../src/agent-manager/copy-session-files"

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
const temp = path.join(os.tmpdir(), "kilo")

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env, windowsHide: true })
}

async function folder(prefix: string): Promise<string> {
  await fs.mkdir(temp, { recursive: true })
  return await fs.mkdtemp(path.join(temp, prefix))
}

async function repo(): Promise<string> {
  const root = await folder("kilo-copy-session-repo-")
  git(root, "init", "--quiet")
  git(root, "config", "user.email", "test@example.invalid")
  git(root, "config", "user.name", "Kilo Test")
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\nignored-dir/\n")
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n")
  await fs.writeFile(path.join(root, "clean.txt"), "clean\n")
  git(root, "add", ".")
  git(root, "commit", "--quiet", "-m", "init")
  return root
}

async function renamedRepo(): Promise<string> {
  const root = await repo()
  await fs.writeFile(path.join(root, "xy file.txt"), "base\n")
  git(root, "add", "xy file.txt")
  git(root, "commit", "--quiet", "-m", "add rename fixture")
  git(root, "mv", "xy file.txt", "renamed.txt")
  return root
}

describe("dirty", () => {
  it("reports modified tracked, untracked, and ignored selected files", async () => {
    const root = await repo()
    await fs.writeFile(path.join(root, "tracked.txt"), "changed\n")
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n")
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored\n")
    await fs.mkdir(path.join(root, "ignored-dir"))
    await fs.writeFile(path.join(root, "ignored-dir", "nested.txt"), "ignored nested\n")

    expect(
      await dirty(root, ["tracked.txt", "untracked.txt", "ignored.txt", "ignored-dir/nested.txt", "clean.txt"]),
    ).toEqual([
      { file: "tracked.txt", reason: "local changes" },
      { file: "untracked.txt", reason: "local changes" },
      { file: "ignored.txt", reason: "local changes" },
      { file: "ignored-dir/nested.txt", reason: "local changes" },
    ])
  })

  it("reports the selected old path for a staged rename", async () => {
    const root = await renamedRepo()

    expect(await dirty(root, ["xy file.txt"])).toEqual([{ file: "xy file.txt", reason: "local changes" }])
  })

  it("does not report a phantom path from a staged rename", async () => {
    const root = await renamedRepo()

    expect(await dirty(root, ["file.txt"])).toEqual([])
  })

  it("reports the selected new path for a staged rename", async () => {
    const root = await renamedRepo()

    expect(await dirty(root, ["renamed.txt"])).toEqual([{ file: "renamed.txt", reason: "local changes" }])
  })
})

describe("copy", () => {
  it("copies new files and creates destination parent directories", async () => {
    const worktreePath = await folder("kilo-copy-session-source-")
    const root = await folder("kilo-copy-session-root-")
    await fs.mkdir(path.join(worktreePath, "nested"))
    await fs.writeFile(path.join(worktreePath, "nested", "new.txt"), "new\n")

    expect(await copy({ worktreePath, root, files: ["nested\\new.txt"] })).toEqual({
      applied: 1,
      removed: 0,
      failed: [],
    })
    expect(await fs.readFile(path.join(root, "nested", "new.txt"), "utf8")).toBe("new\n")
  })

  it("overwrites existing files and removes local files missing from the worktree", async () => {
    const worktreePath = await folder("kilo-copy-session-source-")
    const root = await folder("kilo-copy-session-root-")
    await fs.writeFile(path.join(worktreePath, "keep.txt"), "from worktree\n")
    await fs.writeFile(path.join(root, "keep.txt"), "old local\n")
    await fs.writeFile(path.join(root, "remove.txt"), "remove local\n")

    expect(await copy({ worktreePath, root, files: ["keep.txt", "remove.txt"] })).toEqual({
      applied: 1,
      removed: 1,
      failed: [],
    })
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("from worktree\n")
    await expect(fs.stat(path.join(root, "remove.txt"))).rejects.toThrow()
  })

  it("returns an error before mutating anything when the worktree is missing", async () => {
    const root = await folder("kilo-copy-session-root-")
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n")
    const worktreePath = path.join(root, "missing-worktree")

    expect(await copy({ worktreePath, root, files: ["keep.txt", "new.txt"] })).toEqual({
      error: "Worktree directory not found; nothing was copied",
      applied: 0,
      removed: 0,
      failed: [],
    })
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep\n")
    await expect(fs.stat(path.join(root, "new.txt"))).rejects.toThrow()
  })

  it("rejects absolute and traversal paths without writing outside the root", async () => {
    const worktreePath = await folder("kilo-copy-session-source-")
    const root = await folder("kilo-copy-session-root-")
    const outside = path.join(path.dirname(root), "outside.txt")
    await fs.writeFile(path.join(worktreePath, "safe.txt"), "safe\n")

    const result = await copy({
      worktreePath,
      root,
      files: ["../outside.txt", path.join(path.dirname(root), "absolute.txt"), "safe.txt"],
    })

    expect(result.applied).toBe(1)
    expect(result.removed).toBe(0)
    expect(result.failed).toEqual([
      { file: "../outside.txt", message: "Invalid file path" },
      { file: path.join(path.dirname(root), "absolute.txt"), message: "Invalid file path" },
    ])
    await expect(fs.stat(outside)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, "safe.txt"), "utf8")).toBe("safe\n")
  })

  it("reports a destination directory as a failed file", async () => {
    const worktreePath = await folder("kilo-copy-session-source-")
    const root = await folder("kilo-copy-session-root-")
    await fs.writeFile(path.join(worktreePath, "folder.txt"), "source\n")
    await fs.mkdir(path.join(root, "folder.txt"))

    expect(await copy({ worktreePath, root, files: ["folder.txt"] })).toEqual({
      applied: 0,
      removed: 0,
      failed: [{ file: "folder.txt", message: "Destination is a directory" }],
    })
  })
})
