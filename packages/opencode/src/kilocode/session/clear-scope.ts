// fork_change - new file
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { KiloSessionPrompt } from "./prompt"

export type Scoped = {
  turn: MessageID
  part: SessionV1.Part
}

function realUser(message: SessionV1.WithParts) {
  if (message.info.role !== "user") return false
  if (message.parts.some((part) => part.type === "compaction")) return false
  return message.parts.some((part) => {
    if (part.type !== "text") return true
    return !part.synthetic && !part.ignored
  })
}

function summary(message: SessionV1.WithParts) {
  return message.info.role === "assistant" && message.info.summary === true
}

/**
 * Parts of the prompt projection that belong to turns older than the newest `keep` real user turns.
 * Shared by the manual reasoning and tool-output clears so both agree on what "old" means.
 */
export function old(messages: SessionV1.WithParts[], keep: number) {
  const projected = KiloSessionPrompt.trimBeforeLastSummary(MessageV2.filterCompacted([...messages].reverse()))

  // Every user message belongs to the latest real user turn at or before it.
  const turns: MessageID[] = []
  const users = new Map<MessageID, MessageID | undefined>()
  for (const message of messages) {
    if (message.info.role !== "user") continue
    if (realUser(message)) turns.push(message.info.id)
    users.set(message.info.id, turns.at(-1))
  }
  const owner = (message: SessionV1.WithParts) => {
    if (message.info.role === "user") return users.get(message.info.id)
    if (summary(message)) return undefined
    return users.get(message.info.parentID)
  }

  const stale = new Set(turns.slice(0, Math.max(0, turns.length - keep)))
  const parts: Scoped[] = []
  for (const message of projected) {
    const turn = owner(message)
    if (!turn || !stale.has(turn)) continue
    for (const part of message.parts) parts.push({ turn, part })
  }
  return { projected: projected.length, parts }
}
