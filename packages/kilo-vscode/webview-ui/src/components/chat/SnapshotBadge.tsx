import { For, Show, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import type { SnapshotStatus } from "../../context/session-utils"

const short = (hash: string) => hash.slice(0, 12)

export const SnapshotBadge: Component<{ status: SnapshotStatus }> = (props) => {
  const tooltip = () => (
    <div class="snapshot-badge-tooltip">
      <Show when={props.status.running}>
        <div>Creating snapshot…</div>
      </Show>
      <For each={props.status.events}>
        {(event) => (
          <div>
            {event.phase === "baseline" ? "Baseline" : "Final"}: {short(event.hash)}
          </div>
        )}
      </For>
    </div>
  )

  return (
    <Tooltip value={tooltip()} placement="top">
      <span class="snapshot-badge" data-running={props.status.running ? "" : undefined} aria-label="Snapshot">
        <Show when={props.status.running} fallback={<Icon name="layers" size="small" />}>
          <Spinner />
        </Show>
        <Show when={!props.status.running}>
          <span>{props.status.events.length}</span>
        </Show>
        <Show when={props.status.running}>
          <span>Creating snapshot…</span>
        </Show>
      </span>
    </Tooltip>
  )
}
