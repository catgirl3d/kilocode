// fork_change - new file
import { Show, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import type { EnrichedModel } from "../../context/provider"
import { sanitizeName } from "./model-selector-utils"

interface Props {
  model: EnrichedModel
  favorites: EnrichedModel[]
  onShift: (direction: "up" | "down") => void
}

export const FavoriteRowActions: Component<Props> = (props) => {
  const slot = () =>
    props.favorites.findIndex((item) => item.providerID === props.model.providerID && item.id === props.model.id) + 1
  const moveUp = () => slot() > 1
  const moveDown = () => slot() > 0 && slot() < props.favorites.length

  return (
    <Show when={slot() > 0}>
      <div class="model-selector-favorite-actions">
        <span class="model-selector-favorite-slot">{slot()}</span>
        <button
          type="button"
          class="model-selector-favorite-move"
          aria-label={`↑ ${slot()}: ${sanitizeName(props.model.name)}`}
          disabled={!moveUp()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            props.onShift("up")
          }}
        >
          <Icon name="arrow-up" size="small" />
        </button>
        <button
          type="button"
          class="model-selector-favorite-move"
          aria-label={`↓ ${slot()}: ${sanitizeName(props.model.name)}`}
          disabled={!moveDown()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            props.onShift("down")
          }}
        >
          <Icon name="arrow-up" size="small" class="model-selector-favorite-move-icon--down" />
        </button>
      </div>
    </Show>
  )
}
