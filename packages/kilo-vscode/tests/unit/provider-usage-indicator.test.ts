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

const quota = (value: Partial<ProviderUsageWindow> = {}): ProviderUsageWindow => ({
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

const percent = (used: number, value: Partial<ProviderUsageWindow> = {}): ProviderUsageWindow =>
  quota({ used, remaining: 100 - used, limit: 100, ...value })

const blank = (value: Partial<ProviderUsageWindow> = {}): ProviderUsageWindow =>
  quota({ id: "minimax-weekly", resource: "MiniMax-M2", unit: "unknown", orientation: "amount", ...value })

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
      windows: [percent(20), percent(80, { id: "codex-secondary" })],
    })
    expect(worstUsageWindow(item)?.id).toBe("codex-secondary")
    expect(ringProgress(worstUsageWindow(item))).toBe(80)
  })

  it("ignores windows without a measurable quota", () => {
    expect(worstUsageWindow(snapshot())).toBeUndefined()
    expect(worstUsageWindow(snapshot({ windows: [quota({ state: "unknown" })] }))).toBeUndefined()
    expect(ringProgress(undefined)).toBe(0)
  })

  it("treats an exhausted window as full even when the provider reports no numbers", () => {
    const spent = blank({ state: "exhausted" })
    const item = snapshot({ windows: [percent(20), spent] })
    expect(worstUsageWindow(item)).toBe(spent)
    expect(ringProgress(spent)).toBe(100)
    expect(tone(item)).toBe("critical")
  })

  it("prefers windows that cover the selected model", () => {
    const main = percent(30)
    const spark = percent(95, { id: "spark-primary", resource: "GPT-5.3-Codex-Spark" })
    const item = snapshot({ windows: [main, spark] })
    expect(worstUsageWindow(item, "gpt-5.2-codex")).toBe(main)
    expect(worstUsageWindow(item, "gpt-5.3-codex-spark")).toBe(spark)
  })

  it("falls back to every window when none covers the selected model", () => {
    const main = percent(30)
    const spark = percent(95, { id: "spark-primary", resource: "GPT-5.3-Codex-Spark" })
    expect(worstUsageWindow(snapshot({ windows: [main, spark] }), "gpt-5.2")).toBe(spark)
  })

  it("counts plan-level windows for every model", () => {
    const plan = percent(85, { id: "plan", resource: "subscription" })
    const speech = percent(99, { id: "speech", resource: "speech-02" })
    const chat = percent(10, { id: "chat", resource: "MiniMax-M2" })
    expect(worstUsageWindow(snapshot({ windows: [plan, speech, chat] }), "MiniMax-M2.5")).toBe(plan)
  })

  it("skips a matching window that has no measurable quota", () => {
    const other = percent(40, { id: "speech", resource: "speech-02" })
    expect(worstUsageWindow(snapshot({ windows: [blank({ state: "unknown" }), other] }), "MiniMax-M2.5")).toBe(other)
  })
})

describe("provider usage indicator tone", () => {
  it("stays muted until the snapshot is ready", () => {
    expect(tone(snapshot({ fetchState: "error", windows: [percent(95)] }))).toBe("muted")
    expect(tone(snapshot({ fetchState: "stale", windows: [percent(95)] }))).toBe("muted")
    expect(tone(snapshot({ fetchState: "unavailable" }))).toBe("muted")
  })

  it("grades by used quota and stays muted without measurable data", () => {
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
        percent(42, { period: { unit: "hour", value: 5 }, resetAt: "2026-06-19T05:00:00.000Z" }),
        percent(10, { id: "codex-secondary", period: { unit: "week", value: 1 } }),
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
      windows: [quota({ state: "unlimited" }), quota({ id: "extra", state: "not_in_plan" })],
    })
    expect(usageTooltipRows(item, english, reset)).toEqual([
      { title: "Codex · Quota", value: "Unlimited", reset: undefined },
      { title: "Codex · Quota", value: "Not in plan", reset: undefined },
    ])
  })

  it("mirrors remaining-percent windows and keeps exhausted windows without numbers", () => {
    const item = snapshot({
      windows: [
        quota({ orientation: "remaining_percent", used: 25, remaining: 75, limit: 100 }),
        quota({ id: "codex-secondary", state: "exhausted", used: 100, remaining: 0, limit: 100 }),
        blank({ state: "exhausted" }),
      ],
    })
    expect(usageTooltipRows(item, english, reset)).toEqual([
      { title: "Codex · Quota", value: "25% used, 75% remaining", reset: undefined },
      { title: "Codex · Quota", value: "100% used, 0% remaining", reset: undefined },
      { title: "MiniMax-M2 · Quota", value: "Exhausted", reset: undefined },
    ])
  })
})

describe("provider usage indicator accessibility", () => {
  it("exposes the quota ring as a focusable image with a spoken label", async () => {
    await fixture("provider-usage-indicator-a11y")
  }, 30_000)
})
