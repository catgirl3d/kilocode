// fork_change - new file
import type { ProviderUsage } from "@opencode-ai/schema/kilocode/provider-usage"
import { InstallationVersion } from "../../installation/version"

const limit = 64 * 1024
const timeout = 5_000
const manage = "https://opencode.ai/console/go"
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

type Code = "network" | "auth" | "http" | "size" | "invalid"

class Failure extends Error {
  constructor(readonly code: Code) {
    super(code === "auth" ? "OpenCode Go authentication is unavailable." : "OpenCode Go usage is unavailable.")
  }
}

interface Entry {
  percent?: number
  status?: string
  resetsAt?: string
}

export interface Native {
  rolling?: Entry
  weekly?: Entry
  monthly?: Entry
}

export interface Candidate {
  label: string
  key: string
  url: string
}

function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function number(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function entry(input: unknown): Entry | undefined {
  if (!object(input)) return undefined
  const percent = number(input.percent)
  const status = typeof input.status === "string" ? input.status : undefined
  const usableStatus = status?.trim().toLowerCase() === "rate-limited"
  if (percent === undefined && !usableStatus) return undefined
  return {
    ...(percent === undefined ? {} : { percent }),
    ...(status === undefined ? {} : { status }),
    ...(typeof input.resetsAt === "string" ? { resetsAt: input.resetsAt } : {}),
  }
}

export function base(input: string | undefined) {
  if (!input || input.includes("?") || input.includes("#") || !URL.canParse(input)) return undefined
  const value = new URL(input)
  if (
    value.protocol !== "https:" ||
    value.origin !== "https://opencode.ai" ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  )
    return undefined
  const path = value.pathname.replace(/\/+$/, "")
  const family = path.startsWith("/zen/go/") ? "zen" : path.startsWith("/inference/go/") ? "inference" : undefined
  if (!family) return undefined
  return `${value.origin}/${family}/go/v1/usage`
}

export function decode(input: unknown): Native {
  if (!object(input) || !object(input.usage)) throw new Failure("invalid")
  const native: Native = {
    rolling: entry(input.usage.rolling),
    weekly: entry(input.usage.weekly),
    monthly: entry(input.usage.monthly),
  }
  if (!native.rolling && !native.weekly && !native.monthly) throw new Failure("invalid")
  return native
}

async function body(response: Response) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) {
    response.body?.cancel().catch(() => undefined)
    throw new Failure("size")
  }
  if (!response.body) {
    const value = await response.arrayBuffer()
    if (value.byteLength > limit) throw new Failure("size")
    return new TextDecoder().decode(value)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value) continue
    size += chunk.value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Failure("size")
    }
    chunks.push(chunk.value)
  }
  const value = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(value)
}

export async function query(url: string, key: string, fetcher: typeof fetch = fetch): Promise<Native> {
  const response = await fetcher(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      "User-Agent": `kilo/${InstallationVersion}`,
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  }).catch(() => {
    throw new Failure("network")
  })
  if (!response.ok) {
    response.body?.cancel().catch(() => undefined)
    throw new Failure(response.status === 401 || response.status === 403 ? "auth" : "http")
  }
  let text: string
  try {
    text = await body(response)
  } catch (error) {
    if (error instanceof Failure) throw error
    throw new Failure("network")
  }
  try {
    return decode(JSON.parse(text))
  } catch {
    throw new Failure("invalid")
  }
}

function reset(value: string | undefined) {
  if (value === undefined || !rfc3339.test(value)) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function window(
  id: string,
  period: ProviderUsage.UsagePeriod,
  durationMs: number | undefined,
  value: Entry | undefined,
) {
  if (!value) return undefined
  const percent = number(value.percent)
  const limited = value.status?.trim().toLowerCase() === "rate-limited"
  const resetAt = reset(value.resetsAt)
  const base = {
    id,
    resource: "subscription",
    unit: "percent",
    orientation: "used_percent" as const,
    period,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
  }
  if (percent === undefined) {
    if (!limited) return undefined
    return { ...base, state: "exhausted" as const }
  }
  const used = Math.min(100, Math.max(0, percent))
  return {
    ...base,
    used,
    remaining: 100 - used,
    limit: 100,
    state: limited || used >= 100 ? ("exhausted" as const) : ("active" as const),
  }
}

export function normalize(native: Native, input: { label: string; fetchedAt: string }): ProviderUsage.UsageSnapshot {
  const windows = [
    window("opencode-go-rolling", { unit: "hour", value: 5 }, 18_000_000, native.rolling),
    window("opencode-go-weekly", { unit: "week", value: 1 }, 604_800_000, native.weekly),
    window("opencode-go-monthly", { unit: "month", value: 1 }, undefined, native.monthly),
  ].flatMap((value) => (value === undefined ? [] : [value]))
  if (windows.length === 0) throw new Failure("invalid")
  return {
    id: "opencode-go",
    providerID: "opencode-go",
    sourceKind: "direct",
    providerLabel: input.label,
    planLabel: "Subscription",
    sourceLabel: "API key",
    fetchState: "ready",
    planState: "active",
    routingState: "not_applicable",
    fetchedAt: input.fetchedAt,
    managementUrl: manage,
    windows,
  }
}

function unavailable(label: string, auth: boolean): ProviderUsage.UsageSnapshot {
  return {
    id: "opencode-go",
    providerID: "opencode-go",
    sourceKind: "direct",
    providerLabel: label,
    planLabel: "Subscription",
    sourceLabel: "API key",
    fetchState: "unavailable",
    planState: "unknown",
    routingState: "not_applicable",
    managementUrl: manage,
    windows: [],
    error: {
      code: auth ? "opencode_go_auth_unavailable" : "opencode_go_usage_unavailable",
      message: auth ? "This key cannot read OpenCode Go usage." : "Usage unavailable.",
      retryable: !auth,
    },
  }
}

export async function load(candidate: Candidate, fetcher: typeof fetch = fetch) {
  try {
    const native = await query(candidate.url, candidate.key, fetcher)
    return normalize(native, { label: candidate.label, fetchedAt: new Date().toISOString() })
  } catch (error) {
    return unavailable(candidate.label, error instanceof Failure && error.code === "auth")
  }
}
