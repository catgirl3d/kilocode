// fork_change - new file
import { semanticBranchName, versionedName } from "./branch-name"
import { WorktreeRollbackError } from "./WorktreeManager"
import { sameDirectory } from "../kilo-provider-utils"

interface WorktreeNamingClient {
  branchName: {
    generate: (
      input: {
        directory: string
        sessionID: string
        prompt: string
        providerID?: string
        modelID?: string
      },
      options: { throwOnError: true; signal: AbortSignal },
    ) => Promise<{ data: { branch: string | null } }>
  }
}

interface WorktreeMoveClient {
  experimental: {
    controlPlane: {
      moveSession: (
        input: { sessionID: string; destination: { directory: string }; moveChanges: false },
        options: { throwOnError: true },
      ) => Promise<unknown>
    }
  }
}

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
  client: WorktreeNamingClient,
  input: {
    directory: string
    sessionID: string
    prompt: string
    providerID?: string
    modelID?: string
  },
  log: (message: string) => void,
): Promise<string | null> {
  try {
    const { data } = await client.branchName.generate(input, {
      throwOnError: true,
      signal: AbortSignal.timeout(10_000),
    })
    return data.branch
  } catch (error) {
    log(`Skipped prompt worktree naming: ${error}`)
    return null
  }
}

export async function renameFromPrompt(input: {
  client: WorktreeMoveClient
  manager: WorktreeNamingManager
  state: WorktreeNamingState
  worktree: WorktreeNamingWorktree
  sessionID: string
  generated: string
  prefix: string
  version?: { index: number; total: number }
  log: (message: string) => void
}): Promise<{ branch: string; path: string } | null> {
  if (input.worktree.branchOwned !== true) return null

  const original = { branch: input.worktree.branch, path: input.worktree.path }
  const reconcile = (result: { branch: string; path: string }, reason: string) => {
    try {
      const updated = input.state.renameOwnedWorktree(input.worktree.id, original.branch, result.branch, result.path)
      input.log(
        updated
          ? `${reason}; state was reconciled to the actual location`
          : `${reason}; state could not be reconciled to the actual location`,
      )
    } catch (stateError) {
      input.log(`Prompt worktree rename state reconciliation failed: ${stateError}`)
    }
  }

  let base = semanticBranchName(input.generated, input.prefix)
  if (!base) return null
  if (input.version) base = versionedName(base, input.version.index, input.version.total).branch ?? base
  if (base === original.branch) return null

  const renamed = await input.manager.renameWorktree(original.path, original.branch, base).catch((error) => {
    if (error instanceof WorktreeRollbackError) throw error
    input.log(`Skipped prompt worktree rename: ${error}`)
    return null
  })
  if (!renamed) return null

  try {
    await input.client.experimental.controlPlane.moveSession(
      {
        sessionID: input.sessionID,
        destination: { directory: renamed.path },
        moveChanges: false,
      },
      { throwOnError: true },
    )
  } catch (error) {
    let restored: { branch: string; path: string }
    try {
      restored = await input.manager.renameWorktree(renamed.path, renamed.branch, original.branch)
    } catch (rollback) {
      if (rollback instanceof WorktreeRollbackError) throw rollback
      reconcile(renamed, `Prompt worktree rename rollback failed: ${rollback}`)
      input.log(`Skipped prompt worktree rename after session move failed: ${error}`)
      throw new Error(`Prompt worktree session move failed: ${error}; rollback failed: ${rollback}`)
    }
    if (restored.branch !== original.branch || !sameDirectory(restored.path, original.path)) {
      const reason = `Prompt worktree rename rollback returned ${restored.branch} at ${restored.path} instead of ${original.branch} at ${original.path}`
      reconcile(restored, reason)
      throw new Error(reason)
    }
    input.log(`Skipped prompt worktree rename after session move failed; rollback succeeded: ${error}`)
    return null
  }

  const updated = input.state.renameOwnedWorktree(input.worktree.id, original.branch, renamed.branch, renamed.path)
  if (!updated) input.log(`Prompt worktree rename moved disk but state was inconsistent: ${input.worktree.id}`)
  return renamed
}
