import type { AgentInfo, Config, ConfigCollections, McpConfig } from "../../types/messages" // fork_change

export function removable(agent: AgentInfo | undefined): boolean {
  return !!agent && !agent.native && agent.source !== "organization"
}

// fork_change start
export function mcpConfigScope(name: string, collections: ConfigCollections): "global" | "project" | undefined {
  const source = collections.mcp?.find((entry) => entry.key === name)?.source
  return source === "project" || source === "global" ? source : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function mergeRecord(merged: Record<string, unknown>, scoped: Record<string, unknown>): Record<string, unknown> {
  const result = { ...merged }
  for (const [key, value] of Object.entries(scoped)) {
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value) ? mergeRecord(current, value) : value
  }
  return result
}

export function mcpScopedEntry(merged: McpConfig | undefined, scoped: McpConfig | undefined): McpConfig | undefined {
  if (!scoped) return merged
  return mergeRecord((merged ?? {}) as Record<string, unknown>, scoped as Record<string, unknown>) as McpConfig
}

export function mcpDisplayEntry(
  merged: McpConfig | undefined,
  scoped: McpConfig | undefined,
  draft: McpConfig | undefined,
): McpConfig | undefined {
  return mcpScopedEntry(mcpScopedEntry(merged, scoped), draft)
}

type McpStatusTone = "connected" | "failed" | "attention" | "available" | "disabled" | "unknown"

export function mcpStatusTone(status: string | undefined, enabled: boolean, onDemand: boolean): McpStatusTone {
  if (!enabled) return "disabled"
  if (status === "connected") return "connected"
  if (status === "failed") return "failed"
  if (status === "needs_auth" || status === "needs_client_registration") return "attention"
  if (status === "disabled") return onDemand ? "available" : "disabled"
  return "unknown"
}

export function mcpStatusKey(status: string | undefined, tone: ReturnType<typeof mcpStatusTone>) {
  if (tone === "disabled") return "mcp.status.disabled"
  if (tone === "available") return "mcp.status.ready_on_demand"
  const key: Record<string, string> = {
    connected: "mcp.status.connected",
    failed: "mcp.status.failed",
    needs_auth: "mcp.status.needs_auth",
    disabled: "mcp.status.disabled",
    needs_client_registration: "mcp.status.needs_registration",
  }
  return key[status ?? ""] ?? status
}

export function mcpSwitchChecked(status: string | undefined, enabled: boolean, onDemand: boolean): boolean {
  return onDemand ? enabled : status === "connected"
}

export function mcpSwitchAction(enabled: boolean, onDemand: boolean): "connect" | "disconnect" | "none" {
  if (!enabled) return "disconnect"
  if (onDemand) return "none"
  return "connect"
}

export function mcpConfigPatch(
  name: string,
  collections: ConfigCollections,
  partial: Partial<McpConfig>,
): { scope: "global" | "project" | undefined; patch: Partial<Config> } {
  return {
    scope: mcpConfigScope(name, collections),
    patch: {
      mcp: {
        [name]: partial,
      },
    },
  }
}

export function mcpToggle(
  name: string,
  collections: ConfigCollections,
  enabled: boolean,
  onDemand: boolean,
  update: (scope: "global" | "project", patch: Partial<Config>) => void,
  run: (action: "connect" | "disconnect", name: string) => void,
) {
  const result = mcpConfigPatch(name, collections, { enabled })
  if (result.scope) update(result.scope, result.patch)
  const action = mcpSwitchAction(enabled, onDemand)
  if (action !== "none") run(action, name)
}
// fork_change end
export function selectedDefaultAgentValue(value: string): string | null {
  return value || null
}

export function selectedAgentTextOverrideValue(value: string): string | null {
  return value === "" ? null : value
}

export function selectedAgentNumberOverrideValue(
  value: string,
  parse: (value: string) => number,
): number | null | undefined {
  if (value.trim() === "") return null
  const parsed = parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function shouldClearDefaultAgentWhenAgentBecomesUnavailable(
  nextValue: boolean,
  currentDefaultAgent: string | null | undefined,
  agentName: string,
): boolean {
  return nextValue && currentDefaultAgent === agentName
}
