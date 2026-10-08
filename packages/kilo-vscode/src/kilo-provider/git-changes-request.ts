import { captureGitChangesContext } from "./git-changes-context"
import { captureGitCommitContext, captureGitCommits } from "./git-commits" // fork_change
import { resolveGitChangesTarget } from "./git-changes-target"
import { captureStagedDiff } from "./staged-diff" // fork_change

type Interceptor = (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>

type Context = {
  workspaceDir: (sessionID: string | undefined) => string
  post: (message: unknown) => void
  error: (error: unknown) => string
  before?: Interceptor | null
}

// fork_change start
async function interceptGitCommitRequest(next: Record<string, unknown>, ctx: Context): Promise<boolean> {
  if (next.type === "requestGitCommits") {
    const sid = typeof next.sessionID === "string" ? next.sessionID : undefined
    await captureGitCommits({
      requestId: typeof next.requestId === "string" ? next.requestId : "",
      dir: ctx.workspaceDir(sid),
      query: typeof next.query === "string" ? next.query : "",
      post: ctx.post,
    }).catch((error) => console.error("[Kilo New] Git commit search failed:", error))
    return true
  }

  if (next.type !== "requestGitCommitContext") return false
  const sid = typeof next.sessionID === "string" ? next.sessionID : undefined
  await captureGitCommitContext({
    requestId: typeof next.requestId === "string" ? next.requestId : "",
    dir: ctx.workspaceDir(sid),
    hash: typeof next.hash === "string" ? next.hash : "",
    post: ctx.post,
    error: ctx.error,
  }).catch((error) => console.error("[Kilo New] Git commit context failed:", error))
  return true
}
// fork_change end

export async function interceptMessage(
  msg: Record<string, unknown>,
  ctx: Context,
): Promise<Record<string, unknown> | null> {
  const next = ctx.before
    ? await ctx.before(msg).catch((e) => (console.error("[Kilo New] interceptor error:", e), null))
    : msg
  if (next === null) {
    // Permission messages are handled by KiloProvider, never by an interceptor.
    // A failed project route must release the webview's submitting state.
    if (msg.type === "permissionResponse" && typeof msg.permissionId === "string") {
      ctx.post({ type: "permissionError", permissionID: msg.permissionId })
    }
    return null
  }
  // fork_change start
  if (next.type === "requestStagedDiff") {
    const sid = typeof next.sessionID === "string" ? next.sessionID : undefined
    await captureStagedDiff({
      requestId: typeof next.requestId === "string" ? next.requestId : "",
      dir: ctx.workspaceDir(sid),
      post: ctx.post,
      error: ctx.error,
    }).catch((e) => console.error("[Kilo New] staged diff error:", e))
    return null
  }
  // fork_change end
  if (await interceptGitCommitRequest(next, ctx)) return null // fork_change
  if (next.type !== "requestGitChangesContext") return next
  const sid = typeof next.sessionID === "string" ? next.sessionID : undefined
  const dir = ctx.workspaceDir(sid)
  const resolved = await resolveGitChangesTarget(next, dir)
  await captureGitChangesContext({
    requestId: typeof resolved.requestId === "string" ? resolved.requestId : "",
    dir: typeof resolved.contextDirectory === "string" ? resolved.contextDirectory : dir,
    base: typeof resolved.gitChangesBase === "string" ? resolved.gitChangesBase : undefined,
    post: ctx.post,
    error: ctx.error,
  }).catch((e) => console.error("[Kilo New] git changes error:", e))
  return null
}
