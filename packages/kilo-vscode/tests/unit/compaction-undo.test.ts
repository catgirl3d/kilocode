import { describe, expect, it } from "bun:test"
import { lastCompaction } from "../../src/kilo-provider/compaction-undo"

const marker = { type: "compaction" }
const text = { type: "text" }

const user = (id: string, parts: { type: string }[] = []) => ({ info: { id, role: "user" }, parts })
const assistant = (id: string, parentID: string, extra: Record<string, unknown> = {}) => ({
  info: { id, role: "assistant", parentID, ...extra },
  parts: [],
})

describe("lastCompaction", () => {
  it("finds the requested marker and its summary reply", () => {
    const messages = [
      user("u1", [text]),
      assistant("a1", "u1"),
      user("c1", [marker]),
      assistant("s1", "c1", { summary: true }),
      user("u2", [text]),
    ]

    expect(lastCompaction(messages, "c1")).toEqual({ markerID: "c1", summaryID: "s1" })
  })

  it("rejects a marker that is not the newest compaction", () => {
    const messages = [
      user("c1", [marker]),
      assistant("s1", "c1", { summary: true }),
      user("u1", [text]),
      user("c2", [marker]),
      assistant("s2", "c2", { summary: true }),
    ]

    expect(lastCompaction(messages, "c1")).toBeUndefined()
    expect(lastCompaction(messages, "c2")).toEqual({ markerID: "c2", summaryID: "s2" })
  })

  it("returns undefined without a compaction marker", () => {
    expect(lastCompaction([user("u1", [text]), assistant("a1", "u1")], "u1")).toBeUndefined()
  })

  it("reports a marker whose summary reply never completed", () => {
    expect(lastCompaction([user("u1", [text]), user("c1", [marker])], "c1")).toEqual({
      markerID: "c1",
      summaryID: undefined,
    })
  })

  it("ignores an assistant reply that is not a completed summary", () => {
    const messages = [user("c1", [marker]), assistant("a1", "c1")]

    expect(lastCompaction(messages, "c1")).toEqual({ markerID: "c1", summaryID: undefined })
  })
})
