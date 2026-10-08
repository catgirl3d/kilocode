import { describe, expect, it } from "bun:test"
import { withSessionColor } from "../../webview-ui/src/utils/session-color-map"

describe("withSessionColor", () => {
  it("adds and updates a session color without mutating the input", () => {
    const start = { a: "Red" }

    const added = withSessionColor(start, "b", "Blue")
    expect(added).toEqual({ a: "Red", b: "Blue" })
    expect(start).toEqual({ a: "Red" })

    const updated = withSessionColor(added, "a", "Green")
    expect(updated).toEqual({ a: "Green", b: "Blue" })
  })

  it("clears the entry on null or empty color", () => {
    const start = { a: "Red", b: "Blue" }

    expect(withSessionColor(start, "a", null)).toEqual({ b: "Blue" })
    expect(withSessionColor(start, "a", "")).toEqual({ b: "Blue" })
  })

  it("returns the same map when nothing changes", () => {
    const start = { a: "Red" }

    expect(withSessionColor(start, "a", "Red")).toBe(start)
    expect(withSessionColor(start, "missing", null)).toBe(start)
    expect(withSessionColor(start, "missing", "")).toBe(start)
  })

  it("does not mutate the input when updating or clearing", () => {
    const start = { a: "Red", b: "Blue" }

    const updated = withSessionColor(start, "a", "Green")
    const cleared = withSessionColor(start, "a", null)

    expect(updated).not.toBe(start)
    expect(cleared).not.toBe(start)
    expect(start).toEqual({ a: "Red", b: "Blue" })
  })
})
