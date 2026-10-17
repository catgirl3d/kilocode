import { describe, expect, it } from "bun:test"
import { fixture } from "../fixtures/run"
import { english } from "@kilocode/kilo-gateway/provider-usage"
import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@kilocode/sdk/v2/client"
import {
  ringProgress,
  selectUsageSnapshot,
  usageTone,
  usageTooltipRows,
  worstUsageWindow,
} from "../../webview-ui/src/components/chat/provider-usage-indicator"

const window = (value: Partial<ProviderUsageWindow> = {}): ProviderUsageWindow => ({
  id: "codex-primary",
  resource: "Codex",
  unit: "percent",
  orientation: "used_percent",
  state: "active",
  ...value,
})

const snapshot = (value: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot => ({
  id: "codex-chatgpt",
  providerID: "openai",
  sourceKind: "direct",
  providerLabel: "OpenAI",
  planLabel: "ChatGPT Codex",
  sourceLabel: "ChatGPT OAuth",
  fetchState: "ready",
  planState: "active",
  routingState: "not_applicable",
  windows: [],
  ...value,
})

const percent = (used: number): ProviderUsageWindow => window({ used, remaining: 100 - used, limit: 100 })

const tone = (item: ProviderUsageSnapshot) => usageTone(item, worstUsageWindow(item))

describe("provider usage snapshot selection", () => {
  it("returns no snapshot without data, a selected provider, or a match", () => {
    expect(selectUsageSnapshot(undefined, "openai")).toBeUndefined()
    expect(selectUsageSnapshot([snapshot()], undefined)).toBeUndefined()
    expect(selectUsageSnapshot([snapshot()], "anthropic")).toBeUndefined()
    expect(selectUsageSnapshot([], "openai")).toBeUndefined()
  })

  it("prefers the direct source when a provider reports through several sources", () => {
    const managed = snapshot({ id: "kilo-managed", sourceKind: "kilo_managed" })
    const direct = snapshot({ id: "codex-chatgpt" })
    expect(selectUsageSnapshot([managed, direct], "openai")).toBe(direct)
    expect(selectUsageSnapshot([direct, managed], "openai")).toBe(direct)
  })

  it("keeps a managed-only match", () => {
    const managed = snapshot({ id: "kilo-managed", sourceKind: "kilo_managed" })
    expect(selectUsageSnapshot([managed], "openai")).toBe(managed)
  })
})

describe("provider usage worst window", () => {
  it("picks the window with the highest used percentage", () => {
    const item = snapshot({
      windows: [percent(20), window({ id: "codex-secondary", used: 80, remaining: 20, limit: 100 })],
    })
    expect(worstUsageWindow(item)?.id).toBe("codex-secondary")
    expect(ringProgress(worstUsageWindow(item))).toBe(80)
  })

  it("ignores windows without a measurable quota", () => {
    expect(worstUsageWindow(snapshot())).toBeUndefined()
    expect(worstUsageWindow(snapshot({ windows: [window({ state: "unknown" })] }))).toBeUndefined()
    expect(ringProgress(undefined)).toBe(0)
  })

  it("keeps an exhausted window ahead of an active one", () => {
    const spent = window({ id: "codex-primary", state: "exhausted", used: 100, remaining: 0, limit: 100 })
    expect(worstUsageWindow(snapshot({ windows: [spent, percent(10)] }))).toBe(spent)
    expect(ringProgress(spent)).toBe(100)
  })
})

describe("provider usage indicator tone", () => {
  it("stays muted until the snapshot is ready", () => {
    const item = snapshot({ fetchState: "error", windows: [percent(95)] })
    expect(tone(item)).toBe("muted")
    expect(tone(snapshot({ fetchState: "stale", windows: [percent(95)] }))).toBe("muted")
    expect(tone(snapshot({ fetchState: "unavailable" }))).toBe("muted")
  })

  it("grades by remaining quota and stays muted without measurable data", () => {
    expect(tone(snapshot({ windows: [percent(20)] }))).toBe("success")
    expect(tone(snapshot({ windows: [percent(69)] }))).toBe("success")
    expect(tone(snapshot({ windows: [percent(70)] }))).toBe("warning")
    expect(tone(snapshot({ windows: [percent(89)] }))).toBe("warning")
    expect(tone(snapshot({ windows: [percent(90)] }))).toBe("critical")
    expect(tone(snapshot({ windows: [percent(100)] }))).toBe("critical")
    expect(tone(snapshot())).toBe("muted")
  })
})

describe("provider usage tooltip rows", () => {
  const reset = (value: string) => `Resets ${value}`

  it("renders used and remaining percentages with the window label and reset time", () => {
    const item = snapshot({
      windows: [
        window({
          id: "codex-primary",
          used: 42,
          remaining: 58,
          limit: 100,
          period: { unit: "hour", value: 5 },
          resetAt: "2026-06-19T05:00:00.000Z",
        }),
        window({
          id: "codex-secondary",
          used: 10,
          remaining: 90,
          limit: 100,
          period: { unit: "week", value: 1 },
        }),
      ],
    })
    expect(usageTooltipRows(item, english, reset)).toEqual([
      {
        title: "Codex · 5-hour quota",
        value: "42% used, 58% remaining",
        reset: "Resets 2026-06-19T05:00:00.000Z",
      },
      { title: "Codex · Weekly quota", value: "10% used, 90% remaining", reset: undefined },
    ])
  })

  it("keeps plan states instead of inventing percentages", () => {
    const item = snapshot({
      windows: [window({ state: "unlimited" }), window({ id: "extra", state: "not_in_plan" })],
    })
    expect(usageTooltipRows(item, english, reset)).toEqual([
      { title: "Codex · Quota", value: "Unlimited", reset: undefined },
      { title: "Codex · Quota", value: "Not in plan", reset: undefined },
    ])
  })

  it("reports remaining-percent windows and exhausted quotas without adding a mirror value", () => {
    const item = snapshot({
      windows: [
        window({ orientation: "remaining_percent", used: 25, remaining: 75, limit: 100 }),
        window({ id: "codex-secondary", state: "exhausted", used: 100, remaining: 0, limit: 100 }),
      ],
    })
    expect(usageTooltipRows(item, english, reset)).toEqual([
      { title: "Codex · Quota", value: "75% remaining", reset: undefined },
      { title: "Codex · Quota", value: "100% used, 0% remaining", reset: undefined },
    ])
  })
})

describe("provider usage indicator accessibility", () => {
  it("exposes the quota ring as a focusable status with a spoken label", async () => {
    await fixture("provider-usage-indicator-a11y")
  }, 30_000)
})
