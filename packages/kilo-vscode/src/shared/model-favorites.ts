// fork_change - new file
interface FavoriteModel {
  providerID: string
  modelID: string
}

function key(item: FavoriteModel) {
  return `${item.providerID}/${item.modelID}`
}

export function moveFavorite<T extends FavoriteModel>(
  favorites: T[],
  providerID: string,
  modelID: string,
  direction: "up" | "down",
  visible?: (item: T) => boolean,
): T[] {
  const idx = favorites.findIndex((item) => item.providerID === providerID && item.modelID === modelID)
  if (idx < 0) return favorites

  const step = direction === "up" ? -1 : 1
  let next = idx + step
  while (next >= 0 && next < favorites.length) {
    const candidate = favorites.at(next)
    if (!candidate || !visible || visible(candidate)) break
    next += step
  }
  if (next < 0 || next >= favorites.length) return favorites

  const item = favorites.at(idx)
  const target = favorites.at(next)
  if (!item || !target) return favorites

  const result = [...favorites]
  result[idx] = target
  result[next] = item
  return result
}

/** True when `next` is a pure reordering of `current` (same unique entries). */
export function isFavoriteReorder(current: FavoriteModel[], next: FavoriteModel[]): boolean {
  if (current.length !== next.length) return false
  const keys = new Set(current.map(key))
  const order = new Set(next.map(key))
  if (keys.size !== current.length || order.size !== next.length) return false
  return [...order].every((item) => keys.has(item))
}
