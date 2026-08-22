// fork_change start
import type { SessionStatusInfo } from "../../types/messages"
export function taskMarkerStatus(status: string | undefined) {
  if (status === "pending" || status === "running") return "running" as const
  if (status === "completed" || status === "error") return status
  return undefined
}

export function taskSessionStatus(status: SessionStatusInfo | undefined, parent: string | undefined) {
  if (status?.type === "busy" || status?.type === "retry") return "running" as const
  return taskMarkerStatus(parent)
}

export function taskRunning(status: string | undefined) {
  return taskMarkerStatus(status) === "running"
}
// fork_change end

export function childForeground(
  id: string | undefined,
  part: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
  status: Record<string, SessionStatusInfo>,
  latest: boolean,
) {
  if (!id || !latest) return false
  if (part?.background === true || state?.background === true) return false
  return status[id]?.type === "busy" || status[id]?.type === "retry"
}

export function showChildPromotion(
  id: string | undefined,
  part: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
  status: Record<string, SessionStatusInfo>,
  enabled: boolean | undefined,
  readonly: boolean | undefined,
  latest: boolean,
) {
  return enabled === true && !readonly && childForeground(id, part, state, status, latest)
}

export function taskVisible(open: boolean | undefined, id: string | undefined) {
  return open ? id : undefined
}

export function taskResult(output: string | undefined, id: string | undefined) {
  if (id || typeof output !== "string") return
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  return match?.[1] ?? output
}
