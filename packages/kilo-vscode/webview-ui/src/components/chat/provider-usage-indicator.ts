// fork_change - new file
import { formatWindow, windowLabel, windowProgress, type UsageLabels } from "@kilocode/kilo-gateway/provider-usage"
import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@kilocode/sdk/v2/client"

export type UsageTone = "success" | "warning" | "critical" | "muted"

export interface UsageTooltipRow {
  title: string
  value: string
  reset?: string
}

const WARNING_AT = 70
const CRITICAL_AT = 90

export const selectUsageSnapshot = (
  items: ProviderUsageSnapshot[] | undefined,
  providerID: string | undefined,
): ProviderUsageSnapshot | undefined => {
  if (!items || !providerID) return undefined
  const matches = items.filter((item) => item.providerID === providerID)
  return matches.find((item) => item.sourceKind === "direct") ?? matches.at(0)
}

export const worstUsageWindow = (snapshot: ProviderUsageSnapshot): ProviderUsageWindow | undefined => {
  let worst: ProviderUsageWindow | undefined
  let peak = -1
  for (const item of snapshot.windows) {
    const progress = windowProgress(item)
    if (progress === undefined || progress <= peak) continue
    peak = progress
    worst = item
  }
  return worst
}

export const ringProgress = (window: ProviderUsageWindow | undefined): number => {
  if (!window) return 0
  return windowProgress(window) ?? 0
}

export const usageTone = (snapshot: ProviderUsageSnapshot, window: ProviderUsageWindow | undefined): UsageTone => {
  if (snapshot.fetchState !== "ready") return "muted"
  const progress = window ? windowProgress(window) : undefined
  if (progress === undefined) return "muted"
  if (progress >= CRITICAL_AT) return "critical"
  if (progress >= WARNING_AT) return "warning"
  return "success"
}

const live = (window: ProviderUsageWindow) => window.state === "active" || window.state === "exhausted"

const text = (window: ProviderUsageWindow, labels: UsageLabels) => {
  const parts = [formatWindow(window, labels)]
  const mirror =
    live(window) && window.orientation === "used_percent" && window.used !== undefined && window.remaining !== undefined
  if (mirror) parts.push(formatWindow({ ...window, orientation: "remaining_percent" }, labels))
  return parts.join(", ")
}

export const usageTooltipRows = (
  snapshot: ProviderUsageSnapshot,
  labels: UsageLabels,
  reset: (value: string) => string,
): UsageTooltipRow[] =>
  snapshot.windows.map((window) => ({
    title: windowLabel(window, labels),
    value: text(window, labels),
    reset: window.resetAt ? reset(window.resetAt) : undefined,
  }))
