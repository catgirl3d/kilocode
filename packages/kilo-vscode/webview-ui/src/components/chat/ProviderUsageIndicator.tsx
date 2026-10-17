// fork_change - new file
import { createEffect, createMemo, on, For, Show, type Accessor, type Component } from "solid-js"
import { ProgressCircle } from "@kilocode/kilo-ui/progress-circle"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { localeToBcp47 } from "../../context/language-utils"
import { usageLabels } from "../profile/ProviderUsageCards"
import {
  ringProgress,
  selectUsageSnapshot,
  usageTone,
  usageTooltipRows,
  worstUsageWindow,
} from "./provider-usage-indicator"

const SIZE = 14
const STROKE = 2

export const ProviderUsageIndicator: Component<{ sessionID?: Accessor<string | undefined> }> = (props) => {
  const server = useServer()
  const session = useSession()
  const language = useLanguage()

  const selection = createMemo(() => session.selected(props.sessionID?.()))
  const snapshot = createMemo(() => selectUsageSnapshot(server.providerUsage()?.items, selection()?.providerID))
  const worst = createMemo(() => {
    const item = snapshot()
    return item ? worstUsageWindow(item, selection()?.modelID) : undefined
  })
  const tone = createMemo(() => {
    const item = snapshot()
    return item ? usageTone(item, worst()) : "muted"
  })
  const reset = (value: string) =>
    language.t("profile.usage.reset", { date: new Date(value).toLocaleString(localeToBcp47(language.locale())) })
  const rows = createMemo(() => {
    const item = snapshot()
    if (!item) return []
    return usageTooltipRows(item, usageLabels(language), reset)
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
    const parts = rows().flatMap((row) => [`${row.title}: ${row.value}`, ...(row.reset ? [row.reset] : [])])
    const note = hint()
    if (note) parts.push(note)
    return parts.join(". ")
  })

  // Cache-aware: the backend keeps usage for a minute, so none of these force a provider fetch.
  const request = () => server.requestProviderUsage()

  createEffect(
    on(
      () => selection()?.providerID,
      (provider) => {
        if (provider) request()
      },
    ),
  )

  // A finished turn spends quota, so reload once the session settles.
  createEffect(
    on(session.status, (status, prev) => {
      if (status === "idle" && (prev === "busy" || prev === "retry")) request()
    }),
  )

  return (
    <Show when={snapshot()}>
      <Tooltip
        class="provider-usage-indicator"
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
        <span
          class="provider-usage-indicator-target"
          tabIndex={0}
          role="img"
          aria-label={label()}
          onPointerEnter={request}
          onFocus={request}
        >
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
