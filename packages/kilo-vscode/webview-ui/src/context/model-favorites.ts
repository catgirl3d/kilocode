// fork_change - new file
import { moveFavorite as move } from "../../../src/shared/model-favorites"
import type { ModelSelection } from "../types/messages"
import type { useVSCode } from "./vscode"

interface Deps {
  favorites: () => ModelSelection[]
  setFavorites: (favorites: ModelSelection[]) => void
  post: ReturnType<typeof useVSCode>["postMessage"]
  listen: ReturnType<typeof useVSCode>["onMessage"]
}

export function createSessionFavorites(deps: Deps) {
  function toggleFavorite(providerID: string, modelID: string) {
    const key = `${providerID}/${modelID}`
    const current = deps.favorites()
    const idx = current.findIndex((f) => `${f.providerID}/${f.modelID}` === key)
    const updated = idx >= 0 ? current.filter((_, i) => i !== idx) : [...current, { providerID, modelID }]
    const action = idx >= 0 ? "remove" : "add"
    deps.setFavorites(updated)
    deps.post({ type: "toggleFavorite", action, providerID, modelID })
  }

  function moveFavorite(
    providerID: string,
    modelID: string,
    direction: "up" | "down",
    visible?: (favorite: ModelSelection) => boolean,
  ) {
    const current = deps.favorites()
    const favorites = move(current, providerID, modelID, direction, visible)
    if (favorites === current) return
    deps.setFavorites(favorites)
    deps.post({ type: "moveFavorite", favorites })
  }

  function load() {
    deps.post({ type: "requestFavorites" })
    return deps.listen((message) => {
      if (message.type !== "favoritesLoaded") return
      deps.setFavorites(message.favorites)
    })
  }

  return { toggleFavorite, moveFavorite, load }
}
