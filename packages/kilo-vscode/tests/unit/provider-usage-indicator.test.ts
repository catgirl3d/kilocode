import { describe, expect, it } from "bun:test"
import { fixture } from "../fixtures/run"
import { english } from "@kilocode/kilo-gateway/provider-usage"
import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@kilocode/sdk/v2/client"
import type { KiloPassState, ProfileData } from "../../webview-ui/src/types/messages"
import { showsKiloPass, visibleKiloPass } from "../../webview-ui/src/utils/kilo-pass"
import {
  kiloPassSnapshot,
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

describe("kilo pass snapshot", () => {
  const pass = (value: Partial<KiloPassState> = {}): KiloPassState => ({
    currentPeriodBaseCreditsUsd: 199,
    currentPeriodBonusCreditsUsd: 99.5,
    currentPeriodUsageUsd: 73.27,
    ...value,
  })

  const profile = (value: Partial<ProfileData> = {}): ProfileData => ({
    profile: { email: "user@example.com" },
    balance: null,
    kiloPass: pass(),
    currentOrgId: null,
    ...value,
  })

  it("maps the pass onto a USD amount window using paid plus bonus credits", () => {
    const item = kiloPassSnapshot(pass())
    expect(item?.providerID).toBe("kilo")
    expect(item?.planLabel).toBe("Kilo Pass")
    expect(item?.windows).toHaveLength(1)
    expect(item?.windows[0]).toMatchObject({
      resource: "Kilo Pass",
      unit: "USD",
      orientation: "amount",
      used: 73.27,
      limit: 298.5,
      state: "active",
    })
    expect(item?.windows[0]?.remaining).toBeUndefined()
  })

  it("drives the ring and tone from the pass spend", () => {
    const item = kiloPassSnapshot(pass())
    expect(item).toBeDefined()
    if (!item) return
    expect(ringProgress(worstUsageWindow(item))).toBeCloseTo(24.55, 2)
    expect(usageTone(item, worstUsageWindow(item))).toBe("success")

    const warning = kiloPassSnapshot(pass({ currentPeriodUsageUsd: 210 }))
    expect(warning).toBeDefined()
    if (!warning) return
    expect(usageTone(warning, worstUsageWindow(warning))).toBe("warning")

    const critical = kiloPassSnapshot(pass({ currentPeriodUsageUsd: 298.5 }))
    expect(critical).toBeDefined()
    if (!critical) return
    expect(usageTone(critical, worstUsageWindow(critical))).toBe("critical")
  })

  it("shows the profile card's used and total dollars in the tooltip", () => {
    const item = kiloPassSnapshot(pass())
    expect(item).toBeDefined()
    if (!item) return
    expect(usageTooltipRows(item, english, (value) => `Resets ${value}`)).toEqual([
      { title: "Kilo Pass · Quota", value: "$73.27 of $298.50 used", reset: undefined },
    ])
  })

  it("falls back to the pass window for a Kilo model", () => {
    const item = kiloPassSnapshot(pass())
    expect(item).toBeDefined()
    if (!item) return
    const window = worstUsageWindow(item, "kilo-auto/free")
    expect(window).toBe(item.windows[0])
    expect(ringProgress(window)).toBeCloseTo(24.55, 2)
    expect(usageTone(item, window)).toBe("success")
  })

  it("adds only a valid renewal date to the tooltip", () => {
    const item = kiloPassSnapshot(pass({ nextBillingAt: "2026-07-01T00:00:00.000Z" }))
    expect(item?.windows[0]?.resetAt).toBe("2026-07-01T00:00:00.000Z")
    expect(item).toBeDefined()
    if (!item) return
    expect(usageTooltipRows(item, english, (value) => `Resets ${value}`)).toEqual([
      {
        title: "Kilo Pass · Quota",
        value: "$73.27 of $298.50 used",
        reset: "Resets 2026-07-01T00:00:00.000Z",
      },
    ])

    const missing = kiloPassSnapshot(pass({ nextBillingAt: null }))
    const invalid = kiloPassSnapshot(pass({ nextBillingAt: "not-a-date" }))
    expect(missing?.windows[0]?.resetAt).toBeUndefined()
    expect(invalid?.windows[0]?.resetAt).toBeUndefined()
    if (!missing || !invalid) return
    expect(usageTooltipRows(missing, english, (value) => `Resets ${value}`)[0]?.reset).toBeUndefined()
    expect(usageTooltipRows(invalid, english, (value) => `Resets ${value}`)[0]?.reset).toBeUndefined()
  })

  it("marks a fully spent pass exhausted and hides a pass without credits", () => {
    const spent = kiloPassSnapshot(pass({ currentPeriodUsageUsd: 298.5 }))
    expect(spent?.windows[0]?.state).toBe("exhausted")
    expect(spent).toBeDefined()
    if (!spent) return
    expect(ringProgress(worstUsageWindow(spent))).toBe(100)

    const over = kiloPassSnapshot(pass({ currentPeriodUsageUsd: 400 }))
    expect(over?.windows[0]?.state).toBe("exhausted")

    expect(kiloPassSnapshot(undefined)).toBeUndefined()
    expect(kiloPassSnapshot(pass({ currentPeriodBaseCreditsUsd: 0, currentPeriodBonusCreditsUsd: 0 }))).toBeUndefined()
  })

  it("clamps negative values and ignores non-finite credit totals", () => {
    const item = kiloPassSnapshot(
      pass({ currentPeriodUsageUsd: -5, currentPeriodBaseCreditsUsd: -10, currentPeriodBonusCreditsUsd: 100 }),
    )
    expect(item?.windows[0]).toMatchObject({ used: 0, limit: 100 })
    expect(
      kiloPassSnapshot(pass({ currentPeriodBaseCreditsUsd: Number.NaN, currentPeriodBonusCreditsUsd: 0 })),
    ).toBeUndefined()
  })

  it("shares the profile card's visibility rule but hides the ring without a pass", () => {
    expect(showsKiloPass(undefined)).toBe(false)
    expect(visibleKiloPass(undefined)).toBeUndefined()
    expect(showsKiloPass(profile())).toBe(true)
    expect(visibleKiloPass(profile())).toEqual(pass())
    expect(showsKiloPass(profile({ currentOrgId: "org-1" }))).toBe(false)
    expect(visibleKiloPass(profile({ currentOrgId: "org-1" }))).toBeUndefined()
    const personalOff = profile({ profile: { email: "user@example.com", hasPersonalAccount: false } })
    expect(showsKiloPass(personalOff)).toBe(false)
    expect(visibleKiloPass(personalOff)).toBeUndefined()
    expect(showsKiloPass(profile({ kiloPass: null }))).toBe(true)
    expect(visibleKiloPass(profile({ kiloPass: null }))).toBeUndefined()
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
