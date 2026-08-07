import { describe, expect, test } from "bun:test"
import { select, type Row } from "../../src/kilocode/session/maintenance"

const now = 10_000_000
const old = now - 8 * 24 * 60 * 60 * 1000

function row(id: string, parentID: string | null, updated = old): Row {
  return { id, parentID, title: id, directory: "/repo", updated }
}

describe("Kilo session maintenance", () => {
  test("selects stale leaf children while protecting the current ancestry", () => {
    const result = select(
      [
        row("root", null),
        row("current", "root"),
        row("stale-sibling", "root"),
        row("recent", "root", now),
        row("parent-with-child", "root"),
        row("nested", "parent-with-child"),
      ],
      { current: "current", ageDays: 7, now },
    )

    expect(result.map((item) => item.id)).toEqual(["stale-sibling", "nested"])
  })

  test("does not select root sessions", () => {
    const result = select([row("root", null)], { current: "other", ageDays: 1, now })

    expect(result).toEqual([])
  })

  test("supports cleanup without an active session context", () => {
    const result = select([row("root", null), row("child", "root")], { ageDays: 1, now })

    expect(result.map((item) => item.id)).toEqual(["child"])
  })
})
