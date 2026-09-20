import { describe, expect, it } from "bun:test"
import { moveFavorite } from "../../src/shared/model-favorites"

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
})
