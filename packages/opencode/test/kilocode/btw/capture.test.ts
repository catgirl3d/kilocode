import { describe, expect, test } from "bun:test"
import { BtwCapture } from "../../../src/kilocode/btw/capture"
import type { LLM } from "../../../src/session/llm"

const input = (sessionID: string) =>
  ({
    sessionID,
    messages: [{ role: "user", content: "hi" }],
    system: ["sys"],
    tools: { read: { description: "read", inputSchema: {}, execute: async () => "x" } },
    preflight: true,
  }) as unknown as LLM.StreamInput

describe("BtwCapture", () => {
  test("strips execute and preflight, keeps definitions", () => {
    BtwCapture.record(input("ses_a"), { id: "msg_1" as never })
    const frame = BtwCapture.get("ses_a")
    expect(frame?.assistant).toBe("msg_1" as never)
    expect(frame?.input.preflight).toBeUndefined()
    expect(
      Object.values(frame!.input.tools).every((tool) => (tool as { execute?: unknown }).execute === undefined),
    ).toBe(true)
    expect((frame!.input.tools.read as { description: string }).description).toBe("read")
  })

  test("ignores compaction requests", () => {
    BtwCapture.record(input("ses_b"), { id: "msg_2" as never, summary: true })
    expect(BtwCapture.get("ses_b")).toBeUndefined()
  })

  test("keeps at most 16 sessions, evicting the least recently recorded", () => {
    for (const n of Array.from({ length: 17 }, (_, i) => i))
      BtwCapture.record(input(`ses_lru${n}`), { id: "msg_x" as never })
    expect(BtwCapture.get("ses_lru0")).toBeUndefined()
    for (const n of Array.from({ length: 16 }, (_, i) => i + 1)) expect(BtwCapture.get(`ses_lru${n}`)).toBeDefined()
  })

  test("re-recording a session makes it the newest, so the next insert evicts another one", () => {
    for (const n of Array.from({ length: 16 }, (_, i) => i))
      BtwCapture.record(input(`ses_touch${n}`), { id: "msg_t" as never })
    BtwCapture.record(input("ses_touch1"), { id: "msg_t" as never })
    BtwCapture.record(input("ses_touch16"), { id: "msg_t" as never })
    expect(BtwCapture.get("ses_touch0")).toBeUndefined()
    expect(BtwCapture.get("ses_touch1")).toBeDefined()
    expect(BtwCapture.get("ses_touch16")).toBeDefined()
  })

  test("copy gives each message and content part its own object", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ] as unknown as LLM.StreamInput["messages"]
    const copied = BtwCapture.copy(messages)
    expect(copied).toEqual(messages)
    expect(copied[0]).not.toBe(messages[0])
    expect(copied[0]?.content).not.toBe(messages[0]?.content)
    expect((copied[0]?.content as unknown[])[0]).not.toBe((messages[0]?.content as unknown[])[0])
  })
})
