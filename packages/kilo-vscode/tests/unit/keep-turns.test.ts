import { describe, expect, it } from "bun:test"
import { recallKeepTurns, rememberKeepTurns } from "../../webview-ui/src/utils/keep-turns"

function memory(initial?: unknown) {
  let state = initial
  return {
    get: () => state,
    getState: <T>() => state as T | undefined,
    setState: <T>(next: T) => {
      state = next
    },
  }
}

describe("keep-turns memory", () => {
  it("defaults to 10 when nothing is saved", () => {
    expect(recallKeepTurns(memory(), "tools")).toBe(10)
    expect(recallKeepTurns(memory({}), "reasoning")).toBe(10)
  })

  it("remembers each dialog independently", () => {
    const store = memory()

    rememberKeepTurns(store, "tools", 3)
    expect(recallKeepTurns(store, "tools")).toBe(3)
    expect(recallKeepTurns(store, "reasoning")).toBe(10)

    rememberKeepTurns(store, "reasoning", 25)
    expect(recallKeepTurns(store, "tools")).toBe(3)
    expect(recallKeepTurns(store, "reasoning")).toBe(25)
  })

  it("keeps unrelated webview state when saving", () => {
    const store = memory({ sidebarSide: "left", clearKeepTurns: { reasoning: 4 } })

    rememberKeepTurns(store, "tools", 7)

    expect(store.get()).toEqual({ sidebarSide: "left", clearKeepTurns: { reasoning: 4, tools: 7 } })
  })

  it("ignores values outside 1..100 and corrupt saved state", () => {
    const store = memory({ clearKeepTurns: { tools: 101, reasoning: "5" } })
    expect(recallKeepTurns(store, "tools")).toBe(10)
    expect(recallKeepTurns(store, "reasoning")).toBe(10)

    rememberKeepTurns(store, "tools", 0)
    rememberKeepTurns(store, "tools", 101)
    rememberKeepTurns(store, "tools", 2.5)
    rememberKeepTurns(store, "tools", Number.NaN)
    expect(store.get()).toEqual({ clearKeepTurns: { tools: 101, reasoning: "5" } })

    expect(recallKeepTurns(memory({ clearKeepTurns: "oops" }), "tools")).toBe(10)
    expect(recallKeepTurns(memory("oops"), "tools")).toBe(10)
  })
})
