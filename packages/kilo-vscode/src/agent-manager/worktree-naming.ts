// fork_change - new file
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { semanticBranchName, versionedName } from "./branch-name"
import { WorktreeRollbackError } from "./WorktreeManager"

interface WorktreeNamingManager {
  renameWorktree: (path: string, current: string, requested: string) => Promise<{ branch: string; path: string }>
}

interface WorktreeNamingState {
  renameOwnedWorktree: (id: string, current: string, branch: string, path: string) => boolean
}

interface WorktreeNamingWorktree {
  id: string
  path: string
  branch: string
  branchOwned?: boolean
}

export async function generateFromPrompt(
  client: KiloClient,
  input: { prompt: string; providerID?: string; modelID?: string },
  log: (message: string) => void,
): Promise<string | null> {
  const signal = AbortSignal.timeout(10_000)
  let scratch: string | undefined
  let session: string | undefined
  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-worktree-naming-"))
    const { data: created } = await client.session.create({ directory: scratch }, { throwOnError: true, signal })
    session = created.id
    const { data } = await client.branchName.generate(
      {
        directory: scratch,
        sessionID: session,
        prompt: input.prompt,
        providerID: input.providerID,
        modelID: input.modelID,
      },
      { throwOnError: true, signal },
    )
    return data.branch
  } catch (error) {
    log(`Skipped prompt worktree naming: ${error}`)
    return null
  } finally {
    if (session && scratch) {
      let deleted = false
      for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
        try {
          await client.session.delete(
            { sessionID: session, directory: scratch },
            { throwOnError: true, signal: attempt === 0 ? signal : AbortSignal.timeout(2_000) },
          )
          deleted = true
        } catch (error) {
          if (attempt === 1) log(`Failed to delete scratch naming session: ${error}`)
        }
      }
    }
    if (scratch) {
      try {
        await fs.rm(scratch, { recursive: true, force: true })
      } catch (error) {
        log(`Failed to remove scratch naming directory: ${error}`)
      }
    }
  }
}

export async function renameFromPrompt(input: {
  manager: WorktreeNamingManager
  state: WorktreeNamingState
  worktree: WorktreeNamingWorktree
  generated: string
  prefix: string
  version?: { index: number; total: number }
  log: (message: string) => void
}): Promise<{ branch: string; path: string } | null> {
  if (input.worktree.branchOwned !== true) return null

  const original = { branch: input.worktree.branch, path: input.worktree.path }
  let base = semanticBranchName(input.generated, input.prefix)
  if (!base) return null
  if (input.version) base = versionedName(base, input.version.index, input.version.total).branch ?? base
  if (base === original.branch) return null

  const rename = async (attempt: number): Promise<{ branch: string; path: string } | null> => {
    try {
      return await input.manager.renameWorktree(original.path, original.branch, base)
    } catch (error) {
      if (error instanceof WorktreeRollbackError) throw error
      if (attempt >= 2) {
        input.log(`Skipped prompt worktree rename: ${error}`)
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      return rename(attempt + 1)
    }
  }

  const renamed = await rename(0)
  if (!renamed) return null

  const updated = input.state.renameOwnedWorktree(input.worktree.id, original.branch, renamed.branch, renamed.path)
  if (!updated) input.log(`Prompt worktree rename moved disk but state was inconsistent: ${input.worktree.id}`)
  return renamed
}
