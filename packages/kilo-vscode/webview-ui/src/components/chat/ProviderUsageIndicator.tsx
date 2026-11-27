// fork_change - new file
import { createEffect, createMemo, on, onCleanup, For, Show, type Accessor, type Component } from "solid-js"
import { ProgressCircle } from "@kilocode/kilo-ui/progress-circle"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { formatDateTime } from "@kilocode/kilo-gateway/provider-usage"
import { KILO_PROVIDER_ID } from "../../../../src/shared/provider-model"
import { visibleKiloPass } from "../../utils/kilo-pass"
import { usageLabels } from "../profile/ProviderUsageCards"
import {
  kiloPassSnapshot,
  ringProgress,
  selectUsageSnapshot,
  usageTone,
  usageTooltipRows,
  worstUsageWindow,
} from "./provider-usage-indicator"

const SIZE = 14
const STROKE = 2
const PASS_REFRESH_DELAY = 10_000

export const ProviderUsageIndicator: Component<{ sessionID?: Accessor<string | undefined> }> = (props) => {
  const server = useServer()
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()

  const selection = createMemo(() => session.selected(props.sessionID?.()))
  const pass = createMemo(() => visibleKiloPass(server.profileData()))
  const snapshot = createMemo(() => {
    const selected = selection()
    const item = selectUsageSnapshot(server.providerUsage()?.items, selected?.providerID)
    if (item) return item
    return selected?.providerID === KILO_PROVIDER_ID ? kiloPassSnapshot(pass()) : undefined
  })
  const worst = createMemo(() => {
    const item = snapshot()
    return item ? worstUsageWindow(item, selection()?.modelID) : undefined
  })
  const tone = createMemo(() => {
    const item = snapshot()
    return item ? usageTone(item, worst()) : "muted"
  })
  const reset = (value: string) => language.t("profile.usage.reset", { date: formatDateTime(value) })
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

  let passTimer: ReturnType<typeof setTimeout> | undefined
  const schedulePass = () => {
    if (selection()?.providerID !== KILO_PROVIDER_ID || !pass()) return
    clearTimeout(passTimer)
    passTimer = setTimeout(() => vscode.postMessage({ type: "refreshProfile" }), PASS_REFRESH_DELAY)
  }
  onCleanup(() => clearTimeout(passTimer))

  createEffect(
    on(
      () => selection()?.providerID,
      (provider) => {
        if (!provider) return
        request()
        schedulePass()
      },
    ),
  )

  // A finished turn spends quota, so reload once the session settles. Kilo Pass
  // lives in the profile payload, so a Kilo turn or a switch to Kilo also reloads it.
  createEffect(
    on(session.status, (status, prev) => {
      if (status !== "idle" || (prev !== "busy" && prev !== "retry")) return
      request()
      schedulePass()
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
