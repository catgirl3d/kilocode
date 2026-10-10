// fork_change - new file
import { type Component, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useLanguage } from "../../context/language"

/**
 * Divider shown in place of a compaction marker message. The newest marker
 * carries an action that deletes the marker and its summary reply, which
 * restores the full pre-compaction history for the model.
 */
export const CompactionDivider: Component<{
  undoable?: boolean
  undoDisabled?: boolean
  onUndo?: () => void
}> = (props) => {
  const language = useLanguage()

  return (
    <div data-component="compaction-part" class="vscode-compaction-marker">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {language.t("compaction.divider.label")}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
      <Show when={props.undoable}>
        <div class="vscode-compaction-undo">
          <Tooltip
            value={props.undoDisabled ? language.t("compaction.undo.busy") : language.t("compaction.undo.tooltip")}
            placement="top"
          >
            <Button variant="ghost" size="small" disabled={props.undoDisabled} onClick={() => props.onUndo?.()}>
              {language.t("compaction.undo.label")}
            </Button>
          </Tooltip>
        </div>
      </Show>
    </div>
  )
}
