import { describe, expect, it } from "bun:test"
import { childThinkingPart } from "../../webview-ui/src/components/chat/task-tool-state"
import type { Message, Part, ReasoningPart, ToolPart } from "../../webview-ui/src/types/messages"

const message = (id: string, role: Message["role"]): Message => ({
  id,
  sessionID: "child-1",
  role,
  createdAt: "2026-08-31T00:00:00.000Z",
})

const reasoning = (id: string, text: string): ReasoningPart => ({
  id,
  type: "reasoning",
  text,
})

const tool = (id: string, tool: string): ToolPart => ({
  id,
  type: "tool",
  tool,
  state: { status: "completed" },
})

const parts = (byMessage: Record<string, Part[]>) => (messageID: string) => byMessage[messageID] ?? []

describe("childThinkingPart", () => {
  it("returns the newest reasoning part while the subagent is thinking", () => {
    const messages = [message("u1", "user"), message("a1", "assistant"), message("a2", "assistant")]
    const byMessage: Record<string, Part[]> = {
      a1: [tool("t1", "read")],
      a2: [reasoning("r1", "## Auditing in-flight pruning\n\nchecking the reload path")],
    }
    expect(childThinkingPart(messages, parts(byMessage))).toEqual(byMessage.a2[0])
  })

  it("returns undefined once the next step (tool part) has started", () => {
    const messages = [message("u1", "user"), message("a1", "assistant")]
    const byMessage: Record<string, Part[]> = {
      a1: [reasoning("r1", "## Planning"), tool("t1", "grep")],
    }
    expect(childThinkingPart(messages, parts(byMessage))).toBeUndefined()
  })

  it("does not leak reasoning from an older message when the newest one has no parts yet", () => {
    const messages = [message("u1", "user"), message("a1", "assistant"), message("a2", "assistant")]
    const byMessage: Record<string, Part[]> = {
      a1: [reasoning("r1", "## Old step"), tool("t1", "read")],
      a2: [],
    }
    expect(childThinkingPart(messages, parts(byMessage))).toBeUndefined()
  })

  it("returns undefined while the final answer text is streaming", () => {
    const messages = [message("a1", "assistant")]
    const byMessage: Record<string, Part[]> = {
      a1: [reasoning("r1", "## Step"), { id: "x1", type: "text", text: "Result" }],
    }
    expect(childThinkingPart(messages, parts(byMessage))).toBeUndefined()
  })

  it("returns undefined for a session without assistant messages", () => {
    expect(childThinkingPart([message("u1", "user")], parts({}))).toBeUndefined()
  })
})
