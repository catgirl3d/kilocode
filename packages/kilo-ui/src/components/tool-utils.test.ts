import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@kilocode/sdk/v2"
import { createEffect, createRoot, createSignal } from "solid-js"
import {
  bashLineUpdate,
  createThrottledValue,
  STREAMING_TEXT_RENDER_THROTTLE_MS,
  swePruned,
  TEXT_RENDER_THROTTLE_MS,
} from "./tool-utils"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Drive a source signal quickly and count how often the throttled value changes.
async function countRenders(interval: () => number, ticks: number, tickMs: number) {
  const [source, setSource] = createSignal("")
  let renders = -1
  let dispose = () => {}
  createRoot((d) => {
    dispose = d
    const value = createThrottledValue(source, interval)
    createEffect(() => {
      value()
      renders++
    })
  })
  for (let i = 1; i <= ticks; i++) {
    setSource("x".repeat(i))
    await tick(tickMs)
  }
  await tick(TEXT_RENDER_THROTTLE_MS + 50)
  dispose()
  return renders
}

describe("createThrottledValue cadence", () => {
  test("returns the initial value immediately", () => {
    createRoot((dispose) => {
      const value = createThrottledValue(() => "hello")
      expect(value()).toBe("hello")
      dispose()
    })
  })

  test("repaints more often at the streaming interval than the idle interval", async () => {
    const idle = await countRenders(() => TEXT_RENDER_THROTTLE_MS, 30, 6)
    const streaming = await countRenders(() => STREAMING_TEXT_RENDER_THROTTLE_MS, 30, 6)
    expect(streaming).toBeGreaterThan(idle * 2)
  })

  test("falls back to the idle cadence once streaming ends", async () => {
    const [live, setLive] = createSignal(true)
    const interval = () => (live() ? STREAMING_TEXT_RENDER_THROTTLE_MS : TEXT_RENDER_THROTTLE_MS)

    const fast = await countRenders(interval, 30, 6)
    setLive(false)
    await tick(TEXT_RENDER_THROTTLE_MS + 50)
    const slow = await countRenders(interval, 30, 6)
    expect(fast).toBeGreaterThan(slow)
  })

  test("flushes the pending tail immediately when the cadence slows", async () => {
    const [source, setSource] = createSignal("a")
    const [live, setLive] = createSignal(true)
    let current = ""
    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      const value = createThrottledValue(source, () =>
        live() ? STREAMING_TEXT_RENDER_THROTTLE_MS : TEXT_RENDER_THROTTLE_MS,
      )
      createEffect(() => {
        current = value()
      })
    })
    await tick(20)

    setSource("b")
    await tick(0)
    setSource("c")
    await tick(0)
    setSource("d")
    await tick(0)
    expect(current).toBe("b")

    const start = Date.now()
    setLive(false)
    await tick(0)
    expect(current).toBe("d")
    expect(Date.now() - start).toBeLessThan(50)
    dispose()
  })
})

describe("bashLineUpdate", () => {
  test("skips an unchanged render", () => {
    expect(bashLineUpdate(["a", "b"], ["a", "b"])).toEqual({ start: 0, skip: true, shift: 0 })
  })

  test("starts after the unchanged prefix when lines are appended", () => {
    expect(bashLineUpdate(["a", "b"], ["a", "b", "c"])).toEqual({ start: 2, skip: false, shift: 0 })
  })

  test("re-highlights a changed tail line", () => {
    expect(bashLineUpdate(["a", "b", "c"], ["a", "b", "c2"])).toEqual({ start: 2, skip: false, shift: 0 })
  })

  test("rebuilds when the output shrinks", () => {
    expect(bashLineUpdate(["a", "b", "c"], ["a", "b"])).toEqual({ start: 0, skip: false, shift: 0 })
  })

  test("rebuilds when the front changes", () => {
    expect(bashLineUpdate(["a", "b"], ["x", "b"])).toEqual({ start: 0, skip: false, shift: 0 })
  })

  test("shifts the window when leading lines are dropped", () => {
    expect(bashLineUpdate(["a", "b", "c", "d"], ["c", "d", "e"])).toEqual({ start: 2, skip: false, shift: 2 })
  })

  test("re-highlights only the tail after a shift", () => {
    expect(bashLineUpdate(["a", "b", "c", "d"], ["c", "d2", "e"])).toEqual({ start: 1, skip: false, shift: 2 })
  })

  test("keeps the unchanged prefix when the first line matches", () => {
    expect(bashLineUpdate(["x", "x", "a", "b"], ["x", "a", "b", "c"])).toEqual({
      start: 1,
      skip: false,
      shift: 0,
    })
  })

  test("shifts an empty render into a full render", () => {
    expect(bashLineUpdate([], ["a", "b"])).toEqual({ start: 0, skip: false, shift: 0 })
  })
})
function tool(status: string, metadata?: Record<string, unknown>) {
  return {
    id: "part_swe-pruner",
    sessionID: "ses_swe-pruner",
    messageID: "msg_swe-pruner",
    type: "tool",
    callID: "call_swe-pruner",
    tool: "bash",
    state: { status, metadata },
  } as unknown as ToolPart
}

describe("swePruned", () => {
  test("returns finite integer counts for a completed tool", () => {
    expect(swePruned(tool("completed", { swePruner: { kept: 15, total: 60 } }))).toEqual({ kept: 15, total: 60 })
  })

  test("ignores metadata until the tool is completed", () => {
    expect(swePruned(tool("running", { swePruner: { kept: 15, total: 60 } }))).toBeUndefined()
    expect(swePruned(tool("pending", { swePruner: { kept: 15, total: 60 } }))).toBeUndefined()
  })

  test("rejects missing and malformed metadata", () => {
    const invalid = [
      undefined,
      null,
      "15/60",
      {},
      { kept: 15 },
      { kept: 15.5, total: 60 },
      { kept: Number.POSITIVE_INFINITY, total: 60 },
      { kept: -1, total: 60 },
      { kept: 61, total: 60 },
      { kept: 0, total: 0 },
    ]
    for (const value of invalid) {
      expect(swePruned(tool("completed", { swePruner: value }))).toBeUndefined()
    }
  })
})
