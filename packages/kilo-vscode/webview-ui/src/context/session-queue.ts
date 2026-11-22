import type { Message, Part, SessionInfo, SessionStatusInfo } from "../types/messages"
import type { useVSCode } from "./vscode"

export type RevertBoundary = Pick<NonNullable<SessionInfo["revert"]>, "messageID" | "partID">

export interface MessageTurn {
  id: string
  user: Message
  assistant: Message[]
  partial?: boolean
}

function key(msg: Message) {
  return msg.parentID ?? msg.id
}

function partial(messages: Message[]): MessageTurn {
  const first = messages[0]!
  const id = first.parentID ?? `${first.id}:partial`
  return {
    id,
    user: {
      id,
      sessionID: first.sessionID,
      role: "user",
      createdAt: first.createdAt,
      time: first.time,
    },
    assistant: messages,
    partial: true,
  }
}

function partials(messages: Message[]): MessageTurn[] {
  return messages
    .reduce<Message[][]>((groups, msg) => {
      const prev = groups[groups.length - 1]
      if (!prev || key(prev[0]!) !== key(msg)) {
        groups.push([msg])
        return groups
      }
      prev.push(msg)
      return groups
    }, [])
    .map(partial)
}

function isCompact(msg: Message, parts?: (msg: Message) => Message["parts"]) {
  return msg.role === "user" && (parts?.(msg) ?? msg.parts)?.some((part) => part.type === "compaction")
}

function target(messages: Message[], index: number, id: string, parts?: (msg: Message) => Message["parts"]) {
  const parent = messages.findIndex((msg) => msg.id === id)
  for (let i = index - 1; i > parent; i -= 1) {
    const msg = messages[i]
    if (msg && msg.id > id && isCompact(msg, parts)) return msg.id // fork_change - a compaction older than the parent (revert cleanup removed it) does not own the reply
  }
  return id
}

export function visibleParts(id: string, parts: Part[], revert?: RevertBoundary) {
  // fork_change start
  if (!revert || id !== revert.messageID) return parts
  if (!revert.partID) return []
  // fork_change end
  const idx = parts.findIndex((part) => part.id === revert.partID)
  return idx < 0 ? [] : parts.slice(0, idx)
}

export function messageTurns(
  messages: Message[],
  revert?: RevertBoundary,
  parts?: (msg: Message) => Message["parts"],
): MessageTurn[] {
  const result: MessageTurn[] = []
  const lead: Message[] = []
  const by = new Map<string, { turn: MessageTurn; index: number }>()
  const projected = (msg: Message) => visibleParts(msg.id, parts?.(msg) ?? msg.parts ?? [], revert)
  // fork_change start
  const index = revert ? messages.findIndex((msg) => msg.id === revert.messageID) : -1
  const boundary = revert?.partID ? messages[index] : undefined
  const items = revert?.partID
    ? messages.filter((msg) => {
        if (msg.id === revert.messageID) return true
        if (!boundary) return msg.id < revert.messageID
        const created = Date.parse(msg.createdAt)
        const target = Date.parse(boundary.createdAt)
        return created < target || (created === target && msg.id < boundary.id)
      })
    : index < 0
      ? messages
      : messages.slice(0, index)
  // fork_change end
  let compact: { turn: MessageTurn; index: number } | undefined

  // fork_change start
  for (const msg of items) {
    // fork_change end
    if (msg.role === "user") {
      const turn = { id: msg.id, user: msg, assistant: [] }
      const item = { turn, index: result.length }
      result.push(turn)
      by.set(msg.id, item)
      if (isCompact(msg, projected)) compact = item
      continue
    }

    if (msg.role !== "assistant") continue
    const parent = msg.parentID ? by.get(msg.parentID) : undefined
    if (parent) {
      const turn = compact && parent.index < compact.index ? compact.turn : parent.turn
      turn.assistant.push(msg)
      continue
    }
    if (msg.parentID) {
      if (compact) {
        compact.turn.assistant.push(msg)
        continue
      }
      lead.push(msg)
      continue
    }
    const last = result[result.length - 1]
    if (last) {
      last.assistant.push(msg)
      continue
    }
    lead.push(msg)
  }

  if (lead.length === 0) return result
  return [...partials(lead), ...result]
}

export function visibleMessages(
  messages: Message[],
  revert?: RevertBoundary,
  parts?: (msg: Message) => Message["parts"],
): Message[] {
  return messageTurns(messages, revert, parts).flatMap((turn) =>
    turn.partial ? turn.assistant : [turn.user, ...turn.assistant],
  )
}

function sameMessages(a: Message[], b: Message[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Keep virtua's item keys stable across prepends; Solid's adapter keys by data object identity.
export function stableMessageTurns(next: MessageTurn[], prev: MessageTurn[] = []): MessageTurn[] {
  if (prev.length === 0) return next
  const by = new Map(prev.map((turn) => [turn.user.id, turn]))
  return next.map((turn) => {
    const old = by.get(turn.user.id)
    if (!old) return turn
    if (old.partial !== turn.partial) return turn
    if (!turn.partial && old.user !== turn.user) return turn
    if (!sameMessages(old.assistant, turn.assistant)) return turn
    return old
  })
}

function active(messages: Message[], status: SessionStatusInfo, parts?: (msg: Message) => Message["parts"]) {
  let latest = true
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant") continue
    const resumable = msg.finish === "tool-calls" || msg.finish === "unknown"
    const running = latest && status.type !== "idle" && resumable
    latest = false
    // fork_change start - turns run in order: once the newest assistant has settled, an older
    // unfinished one (left by an interrupted run) is stale and must not queue every later prompt
    if (typeof msg.time?.completed === "number" && !running) break
    if (msg.error) break
    if (msg.finish && !resumable) break
    // fork_change end
    if (!msg.parentID) break
    const id = target(messages, i, msg.parentID, parts)
    const parent = messages.find((item) => item.id === id)
    if (!parent) return id
    if (parent.role === "user") return parent.id
    break
  }

  return undefined
}

function done(messages: Message[], parts?: (msg: Message) => Message["parts"]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant" || !msg.parentID) continue
    // fork_change start - also report where the settled reply sits
    if (typeof msg.time?.completed === "number") return { id: target(messages, i, msg.parentID, parts), index: i }
    if (msg.error) return { id: target(messages, i, msg.parentID, parts), index: i }
    if (msg.finish && !["tool-calls", "unknown"].includes(msg.finish))
      return { id: target(messages, i, msg.parentID, parts), index: i }
    // fork_change end
  }
  return undefined
}

function pending(messages: Message[], parts?: (msg: Message) => Message["parts"]) {
  const users = messages.filter((msg) => msg.role === "user")
  // fork_change start - a settled reply whose user is not loaded (older page, or removed first by
  // revert cleanup) continues with the next user after that reply, not the first loaded user,
  // which would mark the whole loaded history as queued
  const last = done(messages, parts)
  if (!last) return users[0]?.id

  const idx = users.findIndex((msg) => msg.id === last.id)
  if (idx >= 0) return users.at(idx + 1)?.id
  return messages.slice(last.index + 1).find((msg) => msg.role === "user")?.id
  // fork_change end
}

// Find the user message whose turn the server is actively processing.
// Any user message after this one is "queued" (waiting for its turn).
export function activeUserMessageID(
  messages: Message[],
  status: SessionStatusInfo,
  parts?: (msg: Message) => Message["parts"],
  submitting?: boolean,
) {
  if (status.type === "idle" && !submitting) return undefined
  const id = active(messages, status, parts)
  if (id) return id
  return pending(messages, parts)
}

// fork_change start - a prompt the server has not started cannot have a reply yet
function answered(messages: Message[]) {
  return new Set(messages.flatMap((msg) => (msg.role === "assistant" && msg.parentID ? [msg.parentID] : [])))
}

// The server's queue snapshot can go stale: a closed tab stops receiving queue events, and the backend
// clears its last waiting entry without publishing. An idle session or an answered prompt is never queued.
export function serverQueue(ids: string[], messages: Message[], status: SessionStatusInfo, submitting?: boolean) {
  if (status.type === "idle" && !submitting) return []
  const replied = answered(messages)
  return ids.filter((id) => !replied.has(id))
}
// fork_change end

export function queuedUserMessageIDs(
  messages: Message[],
  status: SessionStatusInfo,
  parts?: (msg: Message) => Message["parts"],
  submitting?: boolean,
) {
  if (status.type === "idle" && !submitting) return []
  const users = messages.filter((msg) => msg.role === "user")
  // fork_change start - a prompt the server has not started cannot have a reply yet, so a turn
  // with an assistant reply is never queued; this keeps settled history out of the queue when the
  // active turn cannot be resolved (revert cleanup, or a parent outside the loaded page)
  const replied = answered(messages)
  const waiting = (list: Message[]) => list.map((msg) => msg.id).filter((id) => !replied.has(id))
  // fork_change end
  const running = active(messages, status, parts)
  if (running) {
    const idx = users.findIndex((msg) => msg.id === running)
    if (idx < 0) return waiting(users) // fork_change
    return waiting(users.slice(idx + 1)) // fork_change
  }
  const id = pending(messages, parts)
  const idx = id ? users.findIndex((msg) => msg.id === id) : -1
  if (idx < 0) return []
  return waiting(users.slice(idx + 1)) // fork_change
}

export function partitionTurns(turns: MessageTurn[], ids: ReadonlySet<string>, queued: ReadonlySet<string>) {
  const visible = turns.filter((turn) => !queued.has(turn.user.id))
  const waiting = turns.filter((turn) => queued.has(turn.user.id))
  const idx = visible.findIndex((turn) => ids.has(turn.user.id))
  if (idx === -1) return { virtual: visible, direct: [] as MessageTurn[], queued: waiting }
  return { virtual: visible.slice(0, idx), direct: visible.slice(idx), queued: waiting }
}

export function removeQueuedMessage(
  vscode: Pick<ReturnType<typeof useVSCode>, "onMessage" | "postMessage">,
  sessionID: string,
  messageID: string,
  timeout = 10_000,
) {
  const requestID = crypto.randomUUID()
  return new Promise<boolean>((resolve) => {
    const finish = (success: boolean) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(success)
    }
    const unsubscribe = vscode.onMessage((message) => {
      if (message.type === "connectionState" && (message.state === "disconnected" || message.state === "error")) {
        finish(false)
        return
      }
      if (message.type === "sessionDeleted" && message.sessionID === sessionID) {
        finish(false)
        return
      }
      if (message.type === "deleteMessageResult" && message.requestID === requestID) finish(message.success)
    })
    const timer = setTimeout(() => finish(false), timeout)
    vscode.postMessage({ type: "deleteMessage", sessionID, messageID, requestID })
  })
}
