import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../kilo-provider-utils"
import { TelemetryProxy, TelemetryEventName } from "../services/telemetry"
import { isRunningStatus } from "../session-status" // fork_change
import type { WorktreeStateManager } from "./WorktreeStateManager"
import { PLATFORM } from "./constants"
import { recordForkHandoff } from "./fork-handoff"

export interface ForkContext {
  getClient: () => KiloClient
  state: WorktreeStateManager | undefined
  directory: string | undefined
  postError: (message: string) => void
  registerWorktreeSession: (sessionId: string, directory: string) => void
  pushState: () => void
  notifyForked: (session: Session, forkedFromId: string, worktreeId?: string) => void
  registerSession: (session: Session) => void
  log: (...args: unknown[]) => void
}

/**
 * Fork a session via the CLI backend, register the new session in state,
 * and notify the webview.
 *
 * Pure orchestration — no vscode imports.
 */
export async function forkSession(
  ctx: ForkContext,
  sessionId: string,
  worktreeId?: string,
  messageId?: string,
): Promise<null> {
  let client: KiloClient
  try {
    client = ctx.getClient()
  } catch (err) {
    ctx.log("forkSession: client not available:", err)
    ctx.postError("Not connected to CLI backend")
    return null
  }

  const directory = (() => {
    if (!worktreeId || !ctx.state) return ctx.directory
    return ctx.state.getWorktree(worktreeId)?.path ?? ctx.directory
  })()

  // fork_change start - refuse running sessions for every Agent Manager entry point, matching the sidebar
  const status = await Promise.resolve()
    .then(() => client.session.status({ directory }, { throwOnError: true }))
    .then((result) => result.data?.[sessionId]?.type ?? "idle")
    .catch((err) => {
      ctx.log("forkSession: status check failed:", getErrorMessage(err))
      return "busy" as const
    })
  if (isRunningStatus(status)) {
    ctx.postError("Wait for the session to finish before forking it.")
    return null
  }
  // fork_change end

  let forked: Session
  try {
    const input = { sessionID: sessionId, directory, ...(messageId ? { messageID: messageId } : {}) }
    const { data } = await client.session.fork(input, { throwOnError: true })
    forked = data
  } catch (error) {
    const err = getErrorMessage(error)
    ctx.postError(`Failed to fork session: ${err}`)
    TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
      source: PLATFORM,
      error: err,
      context: "forkSession",
      sessionId,
    })
    return null
  }

  if (worktreeId && ctx.state) {
    ctx.state.addSession(forked.id, worktreeId)
    if (directory) ctx.registerWorktreeSession(forked.id, directory)
  }

  await recordForkHandoff({ client, sessionId: forked.id, directory }).catch((err) => {
    ctx.log("forkSession: failed to record fork handoff:", getErrorMessage(err))
  })

  ctx.pushState()
  ctx.notifyForked(forked, sessionId, worktreeId)
  ctx.registerSession(forked)
  ctx.log(`Forked session ${sessionId} → ${forked.id}${worktreeId ? ` in worktree ${worktreeId}` : ""}`)
  return null
}
