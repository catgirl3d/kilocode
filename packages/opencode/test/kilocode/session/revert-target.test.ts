import { describe, expect, test } from "bun:test"
import { KiloSessionRevert } from "@/kilocode/session/revert"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_revert_target")
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const part = (messageID: MessageID, body: Record<string, unknown>) => ({
  id: PartID.ascending(),
  messageID,
  sessionID,
  ...body,
})

const message = (messageID: MessageID, parts: unknown[]) =>
  ({
    info: { id: messageID, sessionID, role: "assistant" },
    parts,
  }) as never

const question = (messageID: MessageID, metadata: Record<string, unknown>) =>
  part(messageID, {
    type: "tool",
    callID: "call_q",
    tool: "question",
    state: {
      status: "completed",
      input: { questions: [] },
      output: "answered",
      title: "Asked 1 question",
      metadata,
      time: { start: 1, end: 2 },
    },
  })

const finish = (messageID: MessageID) => part(messageID, { type: "step-finish", reason: "tool-calls", cost: 0, tokens })

describe("KiloSessionRevert.target", () => {
  test("returns the input unchanged when no part is named", () => {
    const messageID = MessageID.ascending()
    const input = { sessionID, messageID }

    expect(KiloSessionRevert.target([], input)).toBe(input)
  })

  test("returns the input unchanged for a text part", () => {
    const messageID = MessageID.ascending()
    const text = part(messageID, { type: "text", text: "hello" })
    const input = { sessionID, messageID, partID: text.id }

    expect(KiloSessionRevert.target([message(messageID, [text])], input)).toBe(input)
  })

  test("returns the input unchanged for a question that is still running", () => {
    const messageID = MessageID.ascending()
    const running = part(messageID, {
      type: "tool",
      callID: "call_q",
      tool: "question",
      state: { status: "running", input: { questions: [] }, time: { start: 1 } },
    })
    const after = finish(messageID)
    const input = { sessionID, messageID, partID: running.id }

    expect(KiloSessionRevert.target([message(messageID, [running, after])], input)).toBe(input)
  })

  test("moves a finished question target to the part after it with its checkpoint", () => {
    const messageID = MessageID.ascending()
    const asked = question(messageID, { answers: [["A"]], checkpoint: "snap_q" })
    const after = finish(messageID)

    const result = KiloSessionRevert.target([message(messageID, [asked, after])], {
      sessionID,
      messageID,
      partID: asked.id,
    })

    expect(result).toEqual({ sessionID, messageID, partID: after.id, checkpoint: "snap_q" })
  })

  test("drops a question checkpoint that is not a string", () => {
    const messageID = MessageID.ascending()
    const asked = question(messageID, { answers: [["A"]], checkpoint: 42 })
    const after = finish(messageID)

    const result = KiloSessionRevert.target([message(messageID, [asked, after])], {
      sessionID,
      messageID,
      partID: asked.id,
    })

    expect(result?.partID).toBe(after.id)
    expect(result?.checkpoint).toBeUndefined()
  })

  test("returns undefined when the finished question is the last part of its message", () => {
    const messageID = MessageID.ascending()
    const asked = question(messageID, { answers: [["A"]], checkpoint: "snap_q" })

    const result = KiloSessionRevert.target([message(messageID, [asked])], {
      sessionID,
      messageID,
      partID: asked.id,
    })

    expect(result).toBeUndefined()
  })
})
