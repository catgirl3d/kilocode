// fork_change - new file
import type { UsageLabels } from "@kilocode/kilo-gateway/provider-usage"
import type { useLanguage } from "../context/language"
import { localeToBcp47 } from "../context/language-utils"

type Language = ReturnType<typeof useLanguage>

export const usageLabels = (language: Language): UsageLabels => ({
  unlimited: language.t("profile.usage.status.unlimited"),
  notInPlan: language.t("profile.usage.status.notInPlan"),
  unknown: language.t("profile.usage.status.unknown"),
  exhausted: language.t("profile.usage.status.exhausted"),
  used: (value: string) => language.t("profile.usage.window.used", { value }),
  remaining: (value: string) => language.t("profile.usage.window.remaining", { value }),
  remainingOf: (value: string, limit: string) => language.t("profile.usage.window.remainingOf", { value, limit }),
  usedOf: (value: string, limit: string) => language.t("profile.usage.window.usedOf", { value, limit }),
  quota: language.t("profile.usage.window.quota"),
  daily: language.t("profile.usage.window.daily"),
  weekly: language.t("profile.usage.window.weekly"),
  monthly: language.t("profile.usage.window.monthly"),
  hours: (count: number) => language.t("profile.usage.window.hours", { count: String(count) }),
  days: (count: number) => language.t("profile.usage.window.days", { count: String(count) }),
  weeks: (count: number) => language.t("profile.usage.window.weeks", { count: String(count) }),
  months: (count: number) => language.t("profile.usage.window.months", { count: String(count) }),
  shared: language.t("profile.usage.window.shared"),
  scoped: (resource: string, period: string) => language.t("profile.usage.window.scoped", { resource, period }),
})

export const usageResetText = (language: Language, resetAt: string): string =>
  language.t("profile.usage.reset", { date: new Date(resetAt).toLocaleString(localeToBcp47(language.locale())) })
