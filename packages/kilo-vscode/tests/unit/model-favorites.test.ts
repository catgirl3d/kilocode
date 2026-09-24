import { describe, expect, it } from "bun:test"
import { isFavoriteReorder, moveFavorite } from "../../src/shared/model-favorites"

const favorites = [
  { providerID: "kilo", modelID: "claude" },
  { providerID: "kilo", modelID: "gpt" },
  { providerID: "kilo", modelID: "gemini" },
]

describe("moveFavorite", () => {
  it("moves a favorite one slot without mutating the original order", () => {
    const result = moveFavorite(favorites, "kilo", "gpt", "up")

    expect(result.map((item) => item.modelID)).toEqual(["gpt", "claude", "gemini"])
    expect(favorites.map((item) => item.modelID)).toEqual(["claude", "gpt", "gemini"])
  })

  it("preserves the list when the move would exceed its bounds", () => {
    expect(moveFavorite(favorites, "kilo", "claude", "up")).toBe(favorites)
    expect(moveFavorite(favorites, "kilo", "gemini", "down")).toBe(favorites)
  })

  it("skips entries the visibility predicate rejects", () => {
    const list = [
      { providerID: "kilo", modelID: "claude" },
      { providerID: "kilo", modelID: "gpt" },
      { providerID: "kilo", modelID: "hidden" },
      { providerID: "kilo", modelID: "gemini" },
    ]
    const visible = (item: (typeof list)[number]) => item.modelID !== "hidden"

    const down = moveFavorite(list, "kilo", "gpt", "down", visible)
    expect(down.map((item) => item.modelID)).toEqual(["claude", "gemini", "hidden", "gpt"])

    const up = moveFavorite(list, "kilo", "gemini", "up", visible)
    expect(up.map((item) => item.modelID)).toEqual(["claude", "gemini", "hidden", "gpt"])
  })

  it("preserves the list when no visible neighbor exists in that direction", () => {
    const list = [
      { providerID: "kilo", modelID: "claude" },
      { providerID: "kilo", modelID: "hidden-a" },
      { providerID: "kilo", modelID: "hidden-b" },
    ]
    const visible = (item: (typeof list)[number]) => !item.modelID.startsWith("hidden")

    expect(moveFavorite(list, "kilo", "claude", "down", visible)).toBe(list)
  })
})

describe("isFavoriteReorder", () => {
  it("accepts a reordered permutation", () => {
    expect(isFavoriteReorder(favorites, [favorites[2]!, favorites[0]!, favorites[1]!])).toBe(true)
  })

  it("rejects dropped, added, or duplicated entries", () => {
    expect(isFavoriteReorder(favorites, [favorites[0]!, favorites[1]!])).toBe(false)
    expect(isFavoriteReorder(favorites, [...favorites, { providerID: "kilo", modelID: "extra" }])).toBe(false)
    expect(isFavoriteReorder(favorites, [favorites[0]!, favorites[1]!, favorites[1]!])).toBe(false)
  })
})
