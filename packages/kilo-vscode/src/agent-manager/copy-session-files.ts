// fork_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { exec } from "../util/process"

export interface DirtyFile {
  file: string
  reason: "local changes"
}

export interface CopyFailure {
  file: string
  message: string
}

export interface CopyResult {
  error?: string
  applied: number
  removed: number
  failed: CopyFailure[]
}

interface CopyInput {
  worktreePath: string
  root: string
  files: string[]
}

const statusArgs = ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "-z", "--"]

// fork_change start - shared changed-file path parsing
export function normalize(file: string): string {
  return file.replaceAll("\\", "/")
}
// fork_change end

function valid(file: string): boolean {
  if (!file) return false
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false
  return !file.split("/").includes("..")
}

function code(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = (error as { code?: unknown }).code
  return typeof value === "string" ? value : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// fork_change start - shared status parser
export function statusFiles(stdout: string): Set<string> {
  const files = new Set<string>()
  const records = stdout.split("\0")
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.length < 4 || record[2] !== " ") continue
    files.add(normalize(record.slice(3)))
    if (record.slice(0, 2).includes("R") || record.slice(0, 2).includes("C")) {
      const pair = records[++index]
      if (pair) files.add(normalize(pair))
    }
  }
  return files
}
// fork_change end

function result(input: Pick<CopyResult, "applied" | "removed" | "failed">, error?: string): CopyResult {
  return error ? { error, ...input } : { ...input }
}

export async function dirty(root: string, files: string[]): Promise<DirtyFile[]> {
  const { stdout } = await exec("git", ["-C", root, ...statusArgs], { maxBuffer: 4 * 1024 * 1024 })
  const changed = statusFiles(stdout)
  const selected = new Set(files.map(normalize).filter(valid))
  return [...selected]
    .filter((file) => changed.has(file) || [...changed].some((entry) => entry.endsWith("/") && file.startsWith(entry)))
    .map((file) => ({ file, reason: "local changes" as const }))
}

export async function copy(input: CopyInput): Promise<CopyResult> {
  const source = await fs.stat(input.worktreePath).catch(() => undefined)
  if (!source?.isDirectory()) {
    return result({ applied: 0, removed: 0, failed: [] }, "Worktree directory not found; nothing was copied")
  }

  const state = { applied: 0, removed: 0, failed: [] as CopyFailure[] }
  const files = [...new Set(input.files)]

  for (const original of files) {
    const file = normalize(original)
    if (!valid(file)) {
      state.failed.push({ file: original, message: "Invalid file path" })
      continue
    }

    const src = path.join(input.worktreePath, ...file.split("/"))
    const dst = path.join(input.root, ...file.split("/"))
    const sourceFile = await fs.lstat(src).catch((error: unknown) => error)

    if (sourceFile instanceof Error) {
      if (code(sourceFile) !== "ENOENT") {
        state.failed.push({ file, message: message(sourceFile) })
        continue
      }

      const current = await fs.stat(input.worktreePath).catch(() => undefined)
      if (!current?.isDirectory()) return result(state, "Worktree directory disappeared during copy")

      const target = await fs.lstat(dst).catch(() => undefined)
      if (!target) continue
      if (target.isDirectory()) {
        state.failed.push({ file, message: "Destination is a directory" })
        continue
      }
      try {
        await fs.rm(dst)
        state.removed++
      } catch (error) {
        state.failed.push({ file, message: message(error) })
      }
      continue
    }

    const target = await fs.lstat(dst).catch(() => undefined)
    if (target?.isDirectory()) {
      state.failed.push({ file, message: "Destination is a directory" })
      continue
    }
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
      state.applied++
    } catch (error) {
      state.failed.push({ file, message: message(error) })
    }
  }

  return result(state)
}
