import { describe, expect, test } from "bun:test"
import { KiloSessionControl } from "../../src/kilocode/session/control"

const parts = (metadata: Record<string, unknown>) => [{ type: "text", synthetic: true, metadata }]

describe("KiloSessionControl wakeup classification", () => {
  test("wakeups share the background marker but are not settlements", () => {
    expect(KiloSessionControl.background(parts({ background: true }))).toBe(true)
    expect(KiloSessionControl.settlement(parts({ background: true }))).toBe(true)

    expect(KiloSessionControl.background(parts({ background: true, wakeup: true }))).toBe(true)
    expect(KiloSessionControl.settlement(parts({ background: true, wakeup: true }))).toBe(false)
  })

  test("plain and synthetic foreground prompts are neither background nor settlements", () => {
    expect(KiloSessionControl.background([{ type: "text", synthetic: true }])).toBe(false)
    expect(KiloSessionControl.settlement([{ type: "text", synthetic: true }])).toBe(false)
    expect(KiloSessionControl.background([{ type: "text" }])).toBe(false)
    expect(KiloSessionControl.settlement([{ type: "text" }])).toBe(false)
  })
})
