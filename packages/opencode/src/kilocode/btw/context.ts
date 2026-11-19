// fork_change - new file
import type { ModelMessage } from "ai"
import type { MessageV2 } from "@/session/message-v2"
import type { MessageID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { BtwCapture } from "./capture"
import type { BtwItem } from "./schema"

export namespace BtwContext {
  export const REMINDER = [
    "<system-reminder>",
    "This is an ephemeral side question from the user, asked while the main task continues. It is not part of the main task.",
    "Answer briefly and directly, using the conversation context above.",
    "Do NOT call tools: tools are attached only to keep the prompt cache warm, and any tool call is discarded.",
    "Do NOT ask follow-up questions. Do NOT continue or resume the main task.",
    "</system-reminder>",
  ].join("\n")

  export function prompt(question: string) {
    return `${REMINDER}\n\nSide question: ${question}`
  }

  const open = (part: { time?: { end?: number } }) => part.time != null && part.time.end == null

  // An in-flight assistant contributes only closed text/reasoning and settled tools.
  export function settled(msgs: MessageV2.WithParts[]): MessageV2.WithParts[] {
    return msgs.flatMap((msg) => {
      if (msg.info.role !== "assistant" || msg.info.time.completed != null) return [msg]
      const parts = msg.parts.filter((part) => {
        if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
        if (part.type === "text" || part.type === "reasoning") return !open(part)
        return true
      })
      const kept = parts.some((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool")
      return kept ? [{ info: msg.info, parts }] : []
    })
  }

  // Messages written since the captured step started (its own assistant message included).
  export function newer(msgs: MessageV2.WithParts[], assistant: MessageID) {
    return msgs.filter((msg) => msg.info.id >= assistant)
  }

  // Mirrors SessionRevert.cleanup: the reverted message and every later one leave the context. A part revert keeps
  // the message up to the reverted part, and keeps the whole message when that part is not found.
  export function cut(msgs: MessageV2.WithParts[], revert: NonNullable<Session.Info["revert"]>) {
    const index = msgs.findIndex((msg) => msg.info.id === revert.messageID)
    if (index < 0) return msgs
    const kept = msgs.slice(0, index)
    const target = msgs.at(index)
    if (!target || !revert.partID) return kept
    const at = target.parts.findIndex((part) => part.id === revert.partID)
    if (at < 0) return [...kept, target]
    return [...kept, { info: target.info, parts: target.parts.slice(0, at) }]
  }

  // A frame is usable only while its assistant message still exists (a revert removes it) and no compaction summary
  // came after it (the frame still carries the history the summary replaced).
  export function warm(frame: BtwCapture.Frame | undefined, msgs: MessageV2.WithParts[]): frame is BtwCapture.Frame {
    if (frame == null || !msgs.some((msg) => msg.info.id === frame.assistant)) return false
    return !msgs.some(
      (msg) => msg.info.role === "assistant" && msg.info.summary === true && msg.info.id > frame.assistant,
    )
  }

  export function thread(items: BtwItem[]): ModelMessage[] {
    return items.flatMap((item): ModelMessage[] => [
      { role: "user", content: `Side question: ${item.question}` },
      { role: "assistant", content: item.answer },
    ])
  }
}
