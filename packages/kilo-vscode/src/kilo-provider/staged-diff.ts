// fork_change - new file
import * as fs from "fs/promises"
import * as path from "path"
import { GitOps } from "../agent-manager/GitOps"

export const STAGED_DIFF_FILE = "staged_diff_output.txt"

export type StagedDiffWrite = { kind: "written"; file: string } | { kind: "empty" }

/**
 * Write `git diff --staged` output to `staged_diff_output.txt` in `dir`.
 * Returns `empty` without touching the disk when the index has no changes.
 */
export async function writeStagedDiff(dir: string): Promise<StagedDiffWrite> {
  const git = new GitOps({ log: () => undefined })
  try {
    const probe = await git.execGitBuffer(["rev-parse", "--is-inside-work-tree"], dir)
    if (probe.code !== 0 || probe.stdout.toString("utf8").trim() !== "true") {
      throw new Error(probe.stderr.trim() || "Not a git repository.")
    }
    const result = await git.execGitBuffer(["diff", "--staged"], dir)
    if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff --staged failed")
    if (result.stdout.length === 0) return { kind: "empty" }
    await fs.writeFile(path.join(dir, STAGED_DIFF_FILE), result.stdout)
    return { kind: "written", file: STAGED_DIFF_FILE }
  } finally {
    git.dispose()
  }
}

type Capture = {
  requestId: string
  dir: string
  post: (message: unknown) => void
  error: (error: unknown) => string
}

/** Answer a webview `requestStagedDiff` with the written file or a user-facing error. */
export async function captureStagedDiff(input: Capture): Promise<void> {
  try {
    const result = await writeStagedDiff(input.dir)
    if (result.kind === "empty") {
      input.post({ type: "stagedDiffResult", requestId: input.requestId, empty: true })
      return
    }
    input.post({ type: "stagedDiffResult", requestId: input.requestId, path: result.file })
  } catch (error) {
    console.error("[Kilo New] Failed to write staged diff:", error)
    input.post({
      type: "stagedDiffError",
      requestId: input.requestId,
      error: input.error(error) || "Failed to write staged diff",
    })
  }
}
