import type { Message, Part, ReasoningPart, SessionStatusInfo } from "../../types/messages" // fork_change
// fork_change start
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

/**
 * The child session's live activity part: the last part of its newest assistant
 * message, but only when it is still reasoning. Once a tool part lands (the
 * next step started) or the message has no parts yet, there is no thinking to
 * show — and an older message's reasoning must never leak through as stale.
 */
export function childThinkingPart(
  messages: Message[],
  parts: (messageID: string) => Part[],
): ReasoningPart | undefined {
  const assistant = messages.findLast((msg) => msg.role === "assistant")
  if (!assistant) return undefined
  const last = parts(assistant.id).at(-1)
  return last?.type === "reasoning" ? last : undefined
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
