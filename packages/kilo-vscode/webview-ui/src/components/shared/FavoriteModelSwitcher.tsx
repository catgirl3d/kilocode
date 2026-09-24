// fork_change - new file
import { createMemo, For, Show, type Accessor, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useProvider } from "../../context/provider"
import { useSession } from "../../context/session"
import { sanitizeName, isSmall } from "./model-selector-utils"

const MAX_FAVORITES = 5

interface FavoriteModelSwitcherProps {
  sessionID?: Accessor<string | undefined>
  numbered?: boolean
}

export const FavoriteModelSwitcher: Component<FavoriteModelSwitcherProps> = (props) => {
  const session = useSession()
  const provider = useProvider()
  const id = () => props.sessionID?.()
  const favorites = createMemo(() =>
    session
      .favoriteModels()
      .flatMap((item) => {
        const model = provider.findModel(item)
        if (!model || !provider.isModelValid(item) || isSmall(model)) return []
        return [{ item, model }]
      })
      .slice(0, MAX_FAVORITES)
      .map((favorite, index) => ({ item: favorite.item, model: favorite.model, number: index + 1 })),
  )

  return (
    <div class="favorite-model-switcher" aria-label="Favorite models">
      <For each={favorites()}>
        {(favorite) => {
          const name = sanitizeName(favorite.model.name)
          const selected = () => {
            const model = session.selected(id())
            return model?.providerID === favorite.item.providerID && model.modelID === favorite.item.modelID
          }

          return (
            <Tooltip
              value={`${favorite.number} · ${name}`}
              placement="top"
              openDelay={0}
              contentClass={props.numbered ? "model-quick-switcher-tooltip" : undefined}
            >
              <Button
                variant="ghost"
                size="small"
                class="favorite-model-switcher-slot"
                classList={{
                  "favorite-model-switcher-slot--numbered": props.numbered,
                  "favorite-model-switcher-slot--selected": selected(),
                }}
                aria-label={`${favorite.number}: ${name}`}
                aria-pressed={selected()}
                onClick={() => session.selectModel(favorite.item.providerID, favorite.item.modelID, id())}
              >
                <Show when={props.numbered}>{favorite.number}</Show>
              </Button>
            </Tooltip>
          )
        }}
      </For>
    </div>
  )
}
