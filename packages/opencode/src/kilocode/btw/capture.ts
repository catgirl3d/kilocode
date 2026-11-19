// fork_change - new file
import type { LLM } from "@/session/llm"
import type { MessageID } from "@/session/schema"

// The last request each session sent to the model. /btw replays it as a
// cache-warm prefix. Tools keep their definitions but lose `execute`, so a
// side question can never run a tool, and the stale processor closures are released.
export namespace BtwCapture {
  export type Frame = { input: LLM.StreamInput; assistant: MessageID; time: number }

  const LIMIT = 16
  const frames = new Map<string, Frame>()

  export function strip(tools: LLM.StreamInput["tools"]): LLM.StreamInput["tools"] {
    return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, { ...tool, execute: undefined }]))
  }

  // The native runtime writes providerOptions into the messages it sends, so the frame and each side question's
  // request need their own message and content-part objects.
  export function copy(messages: LLM.StreamInput["messages"]): LLM.StreamInput["messages"] {
    return messages.map(
      (msg) =>
        ({
          ...msg,
          content: Array.isArray(msg.content) ? msg.content.map((part) => ({ ...part })) : msg.content,
        }) as LLM.StreamInput["messages"][number],
    )
  }

  export function record(input: LLM.StreamInput, assistant: { id: MessageID; summary?: boolean }) {
    if (assistant.summary) return
    frames.delete(input.sessionID)
    frames.set(input.sessionID, {
      input: { ...input, tools: strip(input.tools), messages: copy(input.messages), preflight: undefined },
      assistant: assistant.id,
      time: Date.now(),
    })
    for (const key of frames.keys()) {
      if (frames.size <= LIMIT) break
      frames.delete(key)
    }
  }

  export function get(sessionID: string) {
    return frames.get(sessionID)
  }

  export function drop(sessionID: string) {
    frames.delete(sessionID)
  }
}
