import { describe, expect, test } from "bun:test"
import { BtwContext } from "../../../src/kilocode/btw/context"
import type { BtwCapture } from "../../../src/kilocode/btw/capture"
import type { BtwItem } from "../../../src/kilocode/btw/schema"
import type { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"

const user = (id: string) =>
  ({ info: { id, role: "user", time: { created: 1 } }, parts: [] }) as unknown as MessageV2.WithParts

const assistant = (id: string, parts: unknown[], completed?: number) =>
  ({
    info: { id, role: "assistant", time: { created: 1, ...(completed == null ? {} : { completed }) } },
    parts,
  }) as unknown as MessageV2.WithParts

const compaction = (id: string) =>
  ({
    info: { id, role: "assistant", summary: true, time: { created: 1 } },
    parts: [],
  }) as unknown as MessageV2.WithParts

const frame = (id: MessageID): BtwCapture.Frame => ({ input: {} as never, assistant: id })

const label = (part: MessageV2.WithParts["parts"][number]) => {
  if (part.type === "tool") return `tool:${part.state.status}`
  if (part.type === "text") return `text:${part.text}`
  return part.type
}

const item = (id: string, question: string, answer: string): BtwItem => ({
  id,
  sessionID: SessionID.make("ses_btw"),
  threadID: "btw_thread",
  status: "done",
  question,
  answer,
  providerID: "anthropic",
  modelID: "claude",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
})

describe("BtwContext", () => {
  test("settled keeps completed assistant messages untouched", () => {
    const msg = assistant("msg_a", [{ type: "tool", state: { status: "running" } }], 5)
    expect(BtwContext.settled([msg])).toEqual([msg])
  })

  test("settled keeps only closed text, reasoning and settled tools of an in-flight assistant", () => {
    const msg = assistant("msg_b", [
      { type: "text", text: "done", time: { start: 1, end: 2 } },
      { type: "text", text: "", time: { start: 3 } },
      { type: "reasoning", text: "thought", time: { start: 1, end: 2 } },
      { type: "reasoning", text: "", time: { start: 3 } },
      { type: "tool", state: { status: "completed" } },
      { type: "tool", state: { status: "running" } },
      { type: "tool", state: { status: "pending" } },
      { type: "step-start" },
    ])
    expect(BtwContext.settled([msg]).at(0)?.parts.map(label)).toEqual([
      "text:done",
      "reasoning",
      "tool:completed",
      "step-start",
    ])
  })

  test("settled removes an in-flight assistant that has no settled text, reasoning or tool part", () => {
    const msg = assistant("msg_c", [
      { type: "step-start" },
      { type: "text", text: "", time: { start: 3 } },
      { type: "reasoning", text: "", time: { start: 3 } },
    ])
    expect(BtwContext.settled([msg])).toEqual([])
  })

  test("settled keeps an in-flight assistant whose only settled part is a closed reasoning", () => {
    const msg = assistant("msg_r", [
      { type: "step-start" },
      { type: "reasoning", text: "thought", time: { start: 1, end: 2 } },
    ])
    expect(BtwContext.settled([msg]).at(0)?.parts.map(label)).toEqual(["step-start", "reasoning"])
  })

  test("settled keeps a failed tool of an in-flight assistant", () => {
    const msg = assistant("msg_d", [
      { type: "tool", state: { status: "error" } },
      { type: "tool", state: { status: "running" } },
    ])
    expect(BtwContext.settled([msg]).at(0)?.parts.map(label)).toEqual(["tool:error"])
  })

  test("settled treats a text finished at time zero as closed", () => {
    const msg = assistant("msg_e", [{ type: "text", text: "closed", time: { start: 0, end: 0 } }])
    expect(BtwContext.settled([msg]).at(0)?.parts.map(label)).toEqual(["text:closed"])
  })

  test("newer keeps messages at or after the captured assistant, in input order", () => {
    const msgs = [user("msg_c"), assistant("msg_a", []), assistant("msg_b", []), user("msg_d")]
    const ids = BtwContext.newer(msgs, MessageID.make("msg_b")).map((msg) => msg.info.id)
    expect(ids.join(" ")).toBe("msg_c msg_b msg_d")
  })

  test("warm requires a frame whose assistant message still exists", () => {
    const msgs = [user("msg_a"), assistant("msg_b", [])]
    expect(BtwContext.warm(undefined, msgs)).toBe(false)
    expect(BtwContext.warm(frame(MessageID.make("msg_gone")), msgs)).toBe(false)
    expect(BtwContext.warm(frame(MessageID.make("msg_b")), msgs)).toBe(true)
  })

  test("warm goes cold for a compaction summary after the frame's assistant, but not for one before it", () => {
    const after = [user("msg_a"), assistant("msg_b", []), compaction("msg_c")]
    expect(BtwContext.warm(frame(MessageID.make("msg_b")), after)).toBe(false)
    const before = [user("msg_a"), compaction("msg_b"), assistant("msg_c", [])]
    expect(BtwContext.warm(frame(MessageID.make("msg_c")), before)).toBe(true)
  })

  test("thread replays each Q/A pair as a user and an assistant message", () => {
    expect(BtwContext.thread([item("btw_1", "q1", "a1"), item("btw_2", "q2", "a2")])).toEqual([
      { role: "user", content: "Side question: q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "Side question: q2" },
      { role: "assistant", content: "a2" },
    ])
  })

  test("cut drops the reverted message and every later one", () => {
    const msgs = [user("msg_a"), assistant("msg_b", []), user("msg_c")]
    const kept = BtwContext.cut(msgs, { messageID: MessageID.make("msg_b") })
    expect(kept.map((msg) => msg.info.id).join(" ")).toBe("msg_a")
  })

  test("cut with a part keeps the reverted message up to that part", () => {
    const msg = assistant("msg_b", [
      { id: "prt_keep", type: "text", text: "keep" },
      { id: "prt_drop", type: "text", text: "drop" },
    ])
    const cut = BtwContext.cut([user("msg_a"), msg, user("msg_c")], {
      messageID: MessageID.make("msg_b"),
      partID: PartID.make("prt_drop"),
    })
    expect(cut.map((item) => item.info.id).join(" ")).toBe("msg_a msg_b")
    expect(cut[1]!.parts.map(label)).toEqual(["text:keep"])
  })

  test("cut keeps the whole reverted message when its part is not found, and ignores an unknown message", () => {
    const msg = assistant("msg_b", [{ id: "prt_only", type: "text", text: "whole" }])
    const msgs = [user("msg_a"), msg, user("msg_c")]
    const partial = BtwContext.cut(msgs, { messageID: MessageID.make("msg_b"), partID: PartID.make("prt_gone") })
    expect(partial.map((item) => item.info.id).join(" ")).toBe("msg_a msg_b")
    expect(partial[1]!.parts.map(label)).toEqual(["text:whole"])
    expect(BtwContext.cut(msgs, { messageID: MessageID.make("msg_gone") })).toBe(msgs)
  })

  test("cut at the first part keeps the message with no parts, matching revert cleanup", () => {
    const msg = assistant("msg_b", [{ id: "prt_drop", type: "text", text: "drop" }])
    const cut = BtwContext.cut([user("msg_a"), msg], {
      messageID: MessageID.make("msg_b"),
      partID: PartID.make("prt_drop"),
    })
    expect(cut.map((item) => item.info.id).join(" ")).toBe("msg_a msg_b")
    expect(cut[1]!.parts).toEqual([])
  })

  test("prompt starts with the reminder and ends with the question", () => {
    const text = BtwContext.prompt("why?")
    expect(text.startsWith(BtwContext.REMINDER)).toBe(true)
    expect(text.endsWith("Side question: why?")).toBe(true)
  })
})
