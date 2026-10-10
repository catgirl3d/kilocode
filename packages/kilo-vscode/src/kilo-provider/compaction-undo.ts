// fork_change - new file
/**
 * Message shapes needed to locate the newest compaction pair in a session.
 * The compaction marker is a user message carrying a compaction part; its
 * reply is the assistant message with `summary: true` parented to it.
 */
interface CompactionMessage {
  info: { id: string; role: string; parentID?: string; summary?: unknown }
  parts: { type: string }[]
}

/**
 * Locates the newest compaction marker and its summary reply, refusing to act
 * when the requested marker is not the newest one (a stale transcript row), so
 * an outdated click can never delete a newer compaction.
 */
export function lastCompaction(messages: CompactionMessage[], requestedID: string) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    if (msg.info.id !== requestedID) return undefined
    const summary = messages.find(
      (item) => item.info.role === "assistant" && item.info.parentID === msg.info.id && item.info.summary === true,
    )
    return { markerID: msg.info.id, summaryID: summary?.info.id }
  }
  return undefined
}
