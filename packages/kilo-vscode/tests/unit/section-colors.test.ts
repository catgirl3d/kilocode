import { describe, expect, it } from "bun:test"
import { SECTION_COLORS, colorCss, randomColor } from "../../webview-ui/agent-manager/section-colors"

describe("section color palette", () => {
  it("resolves every palette label and rejects unknown ones", () => {
    for (const color of SECTION_COLORS) {
      expect(colorCss(color.label)).toBe(color.css)
    }
    const labels = new Set(SECTION_COLORS.map((color) => color.label))
    expect(labels.size).toBe(SECTION_COLORS.length)
    expect(colorCss("Nope")).toBeUndefined()
    expect(colorCss(null)).toBeUndefined()
  })

  it("keeps randomColor inside the palette and away from non-random swatches", () => {
    const labels = new Set(SECTION_COLORS.map((color) => color.label))
    const picked = new Set(Array.from({ length: 200 }, () => randomColor()))

    expect([...picked].every((label) => labels.has(label))).toBe(true)
    expect(picked.has("White")).toBe(false)
  })
})
