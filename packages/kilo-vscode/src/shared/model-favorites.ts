interface FavoriteModel {
  providerID: string
  modelID: string
}

export function moveFavorite<T extends FavoriteModel>(
  favorites: T[],
  providerID: string,
  modelID: string,
  direction: "up" | "down",
): T[] {
  const idx = favorites.findIndex((item) => item.providerID === providerID && item.modelID === modelID)
  const next = direction === "up" ? idx - 1 : idx + 1
  if (idx < 0 || next < 0 || next >= favorites.length) return favorites

  const result = [...favorites]
  const item = result[idx]
  if (!item) return favorites
  result.splice(idx, 1)
  result.splice(next, 0, item)
  return result
}
