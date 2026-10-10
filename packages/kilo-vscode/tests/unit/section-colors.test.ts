import { describe, expect, it } from "bun:test"
import { dict as en } from "../../webview-ui/src/i18n/en"
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

  it("pins the palette contract: order, labels and hex values", () => {
    expect(SECTION_COLORS.map((color) => [color.label, color.css])).toEqual([
      ["Red", "#e5534b"],
      ["Orange", "#d9822b"],
      ["Yellow", "#d8b13c"],
      ["Green", "#2eb872"],
      ["Cyan", "#29b8db"],
      ["Blue", "#4a9ef7"],
      ["Purple", "#b180d7"],
      ["Magenta", "#c94ec9"],
      ["Coral", "#f2836b"],
      ["Brown", "#a06a3e"],
      ["Lime", "#84cc16"],
      ["Teal", "#14b8a6"],
      ["Indigo", "#6366f1"],
      ["Pink", "#f07ab8"],
      ["Gray", "#8b949e"],
      ["DarkGray", "#59636e"],
      ["White", "#ffffff"],
    ])
  })

  it("keeps every palette label translatable in English", () => {
    for (const color of SECTION_COLORS) {
      const value = en[`session.tags.color.${color.label}` as keyof typeof en]
      expect(typeof value).toBe("string")
      if (typeof value !== "string") continue
      expect(value.length).toBeGreaterThan(0)
      expect(value.replace(/\s/g, "").toLowerCase()).toBe(color.label.replace(/\s/g, "").toLowerCase())
    }
  })

  it("keeps randomColor inside the palette and away from non-random swatches", () => {
    const labels = new Set(SECTION_COLORS.map((color) => color.label))
    const picked = new Set(Array.from({ length: 2000 }, () => randomColor()))

    expect([...picked].every((label) => labels.has(label))).toBe(true)
    expect(picked.has("White")).toBe(false)
    expect(picked.size).toBe(SECTION_COLORS.length - 1)
  })
})
