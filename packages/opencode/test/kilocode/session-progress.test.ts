import { describe, expect, test } from "bun:test"
import { due, rest, trim } from "../../src/kilocode/session/progress"

describe("session progress", () => {
  test("publishes the first sample", () => {
    expect(due(undefined, { at: 1_000, size: 10, rest: "" })).toBe(true)
  })

  test("skips a sample that neither ages past the window nor adds enough output", () => {
    expect(due({ at: 1_000, size: 10, rest: "" }, { at: 1_100, size: 12, rest: "" })).toBe(false)
  })

  test("publishes once the window elapsed", () => {
    expect(due({ at: 1_000, size: 10, rest: "" }, { at: 1_300, size: 12, rest: "" })).toBe(true)
  })

  test("publishes when the output grew enough inside the window", () => {
    expect(due({ at: 1_000, size: 10, rest: "" }, { at: 1_050, size: 3_000, rest: "" })).toBe(true)
  })

  test("caps a chunk stream to a few writes per second", () => {
    let last: { at: number; size: number; rest: string } | undefined
    let writes = 0
    // 1000 chunks, 100 per second, 100 bytes each: the policy should publish per window, not per chunk
    for (let i = 0; i < 1_000; i++) {
      const sample = { at: i * 10, size: i * 100, rest: "" }
      if (due(last, sample)) {
        writes++
        last = sample
      }
    }
    expect(writes).toBeLessThanOrEqual(50)
  })

  test("keeps the tail of an oversized progress payload", () => {
    const text = "a".repeat(10_000) + "END"
    const out = trim(text)
    expect(out.endsWith("END")).toBe(true)
    expect(out.length).toBeLessThan(4_200)
  })

  test("fingerprints metadata without its streamed output", () => {
    expect(rest({ output: "x".repeat(10_000), approval: { source: "yolo" }, exit: 0 })).toBe(
      rest({ output: "other", approval: { source: "yolo" }, exit: 0 }),
    )
  })

  test("publishes when a sibling key changed inside the window", () => {
    const prev = { at: 1_000, size: 10, rest: rest({ output: "a", exit: 0 }) }
    const next = { at: 1_100, size: 12, rest: rest({ output: "ab", exit: 1 }) }
    expect(due(prev, next)).toBe(true)
  })

  test("skips an update that only grew its streamed output inside the window", () => {
    const prev = { at: 1_000, size: 10, rest: rest({ output: "a", exit: 0 }) }
    const next = { at: 1_100, size: 12, rest: rest({ output: "ab", exit: 0 }) }
    expect(due(prev, next)).toBe(false)
  })
})
