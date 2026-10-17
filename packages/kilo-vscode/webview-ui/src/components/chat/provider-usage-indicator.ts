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

// MiniMax can flag a window exhausted without any numbers; it is still a full quota.
const progress = (window: ProviderUsageWindow) => (window.state === "exhausted" ? 100 : windowProgress(window))

// Plan-level windows ("subscription", MiniMax's pooled "general") cover every model.
const covers = (window: ProviderUsageWindow, model: string) =>
  window.resource === "subscription" ||
  window.resource === "general" ||
  (window.resource !== "" && model.includes(window.resource.toLowerCase()))

/**
 * The window that drives the ring: the fullest measurable window that covers
 * the selected model. A quota for another model (a Codex add-on, a MiniMax
 * speech model) only counts when no window matches the model.
 */
export const worstUsageWindow = (snapshot: ProviderUsageSnapshot, model?: string): ProviderUsageWindow | undefined => {
  const measured = snapshot.windows.filter((item) => progress(item) !== undefined)
  const id = model?.toLowerCase()
  const own = id ? measured.filter((item) => covers(item, id)) : []
  const pool = own.length > 0 ? own : measured
  return pool.reduce<ProviderUsageWindow | undefined>(
    (worst, item) => (worst && (progress(worst) ?? 0) >= (progress(item) ?? 0) ? worst : item),
    undefined,
  )
}

export const ringProgress = (window: ProviderUsageWindow | undefined): number => (window ? (progress(window) ?? 0) : 0)

export const usageTone = (snapshot: ProviderUsageSnapshot, window: ProviderUsageWindow | undefined): UsageTone => {
  if (snapshot.fetchState !== "ready" || !window) return "muted"
  const value = progress(window)
  if (value === undefined) return "muted"
  if (value >= CRITICAL_AT) return "critical"
  if (value >= WARNING_AT) return "warning"
  return "success"
}

const live = (window: ProviderUsageWindow) => window.state === "active" || window.state === "exhausted"

const percent = (window: ProviderUsageWindow) =>
  window.orientation === "used_percent" || window.orientation === "remaining_percent"

// Percent windows show both halves, so the tooltip always carries the number the ring draws.
const text = (window: ProviderUsageWindow, labels: UsageLabels) => {
  const both = live(window) && percent(window) && window.used !== undefined && window.remaining !== undefined
  if (!both) return formatWindow(window, labels)
  const used = formatWindow({ ...window, orientation: "used_percent" }, labels)
  const remaining = formatWindow({ ...window, orientation: "remaining_percent" }, labels)
  return `${used}, ${remaining}`
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
