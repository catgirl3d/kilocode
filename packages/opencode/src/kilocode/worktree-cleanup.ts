import * as fs from "fs/promises"
import { Effect } from "effect"
import { unlinkLinks } from "@opencode-ai/core/kilocode/unlink-links" // fork_change

type GitResult = { code: number; text: string; stderr: string }

function opts() {
  return process.platform === "win32" ? { retries: 60, delay: 500 } : { retries: 5, delay: 100 }
}

function locked(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EBUSY", "EACCES", "EPERM"].includes(String(error.code))
  )
}

function transient(result: GitResult) {
  const text = `${result.stderr}\n${result.text}`.toLowerCase()
  return [
    "ebusy",
    "eacces",
    "eperm",
    "directory not empty",
    "resource busy",
    "permission denied",
    "access is denied",
    "process cannot access",
  ].some((item) => text.includes(item))
}

export namespace WorktreeCleanup {
  export async function removeDirectory(target: string) {
    const cfg = opts()
    const rm = async (left: number): Promise<void> =>
      fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(async (error) => {
        if (!locked(error)) throw error
        if (left <= 1) throw error
        if (process.platform === "win32") Bun.gc(true)
        await Bun.sleep(cfg.delay)
        return rm(left - 1)
      })
    return rm(cfg.retries)
  }

  export function remove<R, E, R2, E2>(input: {
    root: string
    target: string
    git: (args: string[], opts?: { cwd?: string }) => Effect.Effect<GitResult, E, R>
    stop: (target: string) => Effect.Effect<unknown, E2, R2>
  }) {
    const cfg = opts()
    return Effect.gen(function* () {
      // fork_change start - git follows Windows junctions out of the worktree; unlink them first or refuse
      const refused = yield* Effect.promise(() =>
        unlinkLinks(input.target).then(
          () => undefined,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        ),
      )
      if (refused) return { code: 1, text: "", stderr: refused } satisfies GitResult
      // fork_change end
      for (const attempt of Array.from({ length: cfg.retries }, (_, i) => i)) {
        yield* input.stop(input.target)
        const result = yield* input.git(["worktree", "remove", "--force", input.target], { cwd: input.root })
        if (result.code === 0) return result
        if (!transient(result)) return result
        if (attempt === cfg.retries - 1) return result
        if (process.platform === "win32") yield* Effect.sync(() => Bun.gc(true))
        yield* Effect.sleep(`${cfg.delay} millis`)
      }
      return { code: 1, text: "", stderr: "Failed to remove git worktree" } satisfies GitResult
    })
  }
}
