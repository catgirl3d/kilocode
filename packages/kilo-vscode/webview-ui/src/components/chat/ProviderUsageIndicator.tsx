// fork_change - new file
import { createEffect, createMemo, on, For, Show, type Accessor, type Component } from "solid-js"
import { ProgressCircle } from "@kilocode/kilo-ui/progress-circle"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { usageLabels, usageResetText } from "../../utils/usage-labels"
import {
  ringProgress,
  selectUsageSnapshot,
  usageTone,
  usageTooltipRows,
  worstUsageWindow,
} from "./provider-usage-indicator"

interface ProviderUsageIndicatorProps {
  sessionID?: Accessor<string | undefined>
}

const REFRESH_AT = 60_000
const SIZE = 14
const STROKE = 2

export const ProviderUsageIndicator: Component<ProviderUsageIndicatorProps> = (props) => {
  const server = useServer()
  const session = useSession()
  const language = useLanguage()

  const selection = createMemo(() => session.selected(props.sessionID?.()))
  const snapshot = createMemo(() => selectUsageSnapshot(server.providerUsage()?.items, selection()?.providerID))
  const worst = createMemo(() => {
    const item = snapshot()
    return item ? worstUsageWindow(item) : undefined
  })
  const tone = createMemo(() => {
    const item = snapshot()
    return item ? usageTone(item, worst()) : "muted"
  })
  const rows = createMemo(() => {
    const item = snapshot()
    if (!item) return []
    return usageTooltipRows(item, usageLabels(language), (value) => usageResetText(language, value))
  })
  const hint = createMemo(() => {
    const item = snapshot()
    if (!item) return undefined
    if (item.fetchState === "stale") return language.t("profile.usage.state.stale")
    if (item.fetchState !== "ready") return language.t("profile.usage.state.unavailable")
    if (rows().length === 0) return language.t("profile.usage.state.empty")
    return undefined
  })
  const label = createMemo(() => {
    if (!snapshot()) return undefined
    const parts = rows().map((row) => `${row.title}: ${row.value}`)
    const note = hint()
    if (note) parts.push(note)
    return parts.join(". ")
  })

  createEffect(
    on(
      () => selection()?.providerID,
      () => server.requestProviderUsage(),
    ),
  )

  let refreshed = 0
  const refresh = () => {
    const now = Date.now()
    if (now - refreshed < REFRESH_AT) return
    refreshed = now
    server.refreshProviderUsage()
  }

  return (
    <Show when={snapshot()}>
      <Tooltip
        placement="top"
        openDelay={0}
        value={
          <div class="provider-usage-indicator-tooltip">
            <For each={rows()}>
              {(row) => (
                <div class="provider-usage-indicator-tooltip-row">
                  <span>{`${row.title}: ${row.value}`}</span>
                  <Show when={row.reset}>
                    {(reset) => <span class="provider-usage-indicator-tooltip-note">{reset()}</span>}
                  </Show>
                </div>
              )}
            </For>
            <Show when={hint()}>{(note) => <span class="provider-usage-indicator-tooltip-note">{note()}</span>}</Show>
          </div>
        }
      >
        <span class="provider-usage-indicator" tabIndex={0} role="status" aria-label={label()} onPointerEnter={refresh}>
          <ProgressCircle
            percentage={ringProgress(worst())}
            size={SIZE}
            strokeWidth={STROKE}
            class={`provider-usage-indicator-ring provider-usage-indicator-ring--${tone()}`}
          />
        </span>
      </Tooltip>
    </Show>
  )
}
