import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { simpleGit } from "simple-git"
import { WorktreeManager } from "../../src/agent-manager/WorktreeManager"
import { GitOps } from "../../src/agent-manager/GitOps"

// Each test gets its own temp directory -- no shared state, safe to run in parallel.
export const tempDirs: string[] = []

// Git may release worktree handles asynchronously on Windows.
export async function removeDir(dir: string): Promise<void> {
  const delays = [0, 100, 200, 300, 500, 1000, 1000, 1000]
  for (const [attempt, delay] of delays.entries()) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (attempt === delays.length - 1 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code)) throw err
    }
  }
}

export async function cleanup(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await removeDir(dir)
    }),
  )
}

export function gitExec(args: string[]) {
  const res = Bun.spawnSync(args, { stdout: "ignore", stderr: "pipe" })
  if (res.exitCode !== 0) {
    const err = Buffer.from(res.stderr).toString("utf8")
    throw new Error(`git command failed (${args.join(" ")}): ${err}`)
  }
}

/** Create a temp git repo with an initial commit (required for worktrees). */
export async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-"))
  tempDirs.push(dir)
  gitExec(["git", "init", "-b", "main", dir])
  gitExec(["git", "-C", dir, "config", "user.email", "test@test.com"])
  gitExec(["git", "-C", dir, "config", "user.name", "Test"])
  await fs.writeFile(path.join(dir, "README.md"), "init")
  gitExec(["git", "-C", dir, "add", "."])
  gitExec(["git", "-C", dir, "commit", "-m", "initial commit"])
  return dir
}

export function createManager(root: string, ops?: GitOps): WorktreeManager {
  const logs: string[] = []
  return new WorktreeManager(root, (msg) => logs.push(msg), ops)
}

// Test-only helper to verify metadata writes keep the temp worktree checkout clean.
export async function changedFiles(cwd: string): Promise<string[]> {
  const raw = await simpleGit(cwd).raw(["status", "--porcelain", "--untracked-files=all", "--"])
  return raw.trim().split("\n").filter(Boolean)
}

/** Create a temp repo with a bare origin remote so origin/<branch> refs exist. */
export async function createTempRepoWithOrigin(): Promise<{ bare: string; clone: string }> {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-bare-"))
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-clone-"))
  tempDirs.push(bare, clone)

  gitExec(["git", "init", "--bare", "-b", "main", bare])
  gitExec(["git", "clone", bare, clone])
  gitExec(["git", "-C", clone, "config", "user.email", "test@test.com"])
  gitExec(["git", "-C", clone, "config", "user.name", "Test"])
  await fs.writeFile(path.join(clone, "README.md"), "init")
  gitExec(["git", "-C", clone, "add", "."])
  gitExec(["git", "-C", clone, "commit", "-m", "initial commit"])
  gitExec(["git", "-C", clone, "push", "-u", "origin", "main"])

  return { bare, clone }
}

const managers: WorktreeManager[] = []

// Pool home for the current test. Slots never live inside the test repository.
export let home = ""

export async function setupPool(): Promise<void> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kilo-pool-home-")))
  tempDirs.push(dir)
  home = path.join(dir, "worktree-pool")
}

export async function cleanupPool(): Promise<void> {
  const active = managers.splice(0, managers.length)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.all(active.map((manager) => manager.disposePool()))
  await cleanup()
}

export async function createPoolRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-pool-"))
  tempDirs.push(dir)
  gitExec(["git", "init", "-b", "main", dir])
  gitExec(["git", "-C", dir, "config", "user.email", "test@test.com"])
  gitExec(["git", "-C", dir, "config", "user.name", "Test"])
  await fs.writeFile(path.join(dir, "README.md"), "init")
  gitExec(["git", "-C", dir, "add", "."])
  gitExec(["git", "-C", dir, "commit", "-m", "initial commit"])
  return dir
}

export function createPoolManager(
  root: string,
  poolSize = 1,
  rewarmDelay = 8_000,
  logs?: string[],
  dir = home,
): WorktreeManager {
  const manager = new WorktreeManager(
    root,
    logs ? (msg) => logs.push(msg) : () => undefined,
    undefined,
    undefined,
    poolSize,
    dir,
  )
  manager.rewarmDelay = rewarmDelay
  managers.push(manager)
  return manager
}

export function metaFile(wt: string): string {
  const pointer = readFileSync(path.join(wt, ".git"), "utf-8")
  return path.join(path.resolve(wt, pointer.match(/^gitdir:\s*(.+)$/m)![1]!.trim()), "kilo-agent-manager-metadata.json")
}

export async function pooledSlots(root: string): Promise<string[]> {
  const raw = await simpleGit(root).raw(["worktree", "list", "--porcelain"])
  const slots: string[] = []
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n")
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9)
    const detached = lines.some((line) => line === "detached")
    if (worktree && detached) slots.push(worktree)
  }
  return slots
}

export async function slotMeta(slot: string): Promise<Record<string, unknown> | undefined> {
  const pointer = await fs.readFile(path.join(slot, ".git"), "utf-8").catch(() => undefined)
  const match = pointer?.match(/^gitdir:\s*(.+)$/m)
  if (!match) return undefined
  const dir = path.resolve(slot, match[1]!.trim())
  const raw = await fs.readFile(path.join(dir, "kilo-agent-manager-metadata.json"), "utf-8").catch(() => undefined)
  if (!raw) return undefined
  return JSON.parse(raw) as Record<string, unknown>
}

export async function waitForPooledSlot(root: string, timeout = 10000): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const slot of await pooledSlots(root)) {
      if ((await slotMeta(slot))?.pooled === true) return slot
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for a pooled slot")
}
