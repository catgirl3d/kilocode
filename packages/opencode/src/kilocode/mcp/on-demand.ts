// fork_change - new file
import type { Config } from "@/config/config"

export type ServerStatus = { status: string }
export type Entry = { name: string; description?: string }

export type McpEntry = {
  type?: unknown
  enabled?: unknown
  on_demand?: unknown
  description?: unknown
}

export function isConfigured(value: unknown): value is McpEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "local" || value.type === "remote")
  )
}

function isEligible(value: unknown): value is McpEntry {
  return isConfigured(value) && value.on_demand === true && value.enabled !== false
}

function description(value: unknown) {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/g, " ").trim().slice(0, 200)
  return text || undefined
}

export function entries(cfg: Config.Info, status: Record<string, ServerStatus>): Entry[] {
  return Object.entries(cfg.mcp ?? {})
    .filter(([name, value]) => {
      return isEligible(value) && status[name]?.status !== "connected"
    })
    .map(([name, value]) => {
      const desc = description(value.description)
      return desc === undefined ? { name } : { name, description: desc }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function escape(value: string) {
  return value.replace(/[&<>"\n\r\t]/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === "\n") return "&#10;"
    if (char === "\r") return "&#13;"
    if (char === "\t") return "&#9;"
    return "&quot;"
  })
}

export function prompt(list: Entry[]): string | undefined {
  if (list.length === 0) return undefined
  return [
    "<mcp_servers_on_demand>",
    ...list.map((entry) =>
      entry.description === undefined
        ? `  <server name="${escape(entry.name)}" />`
        : `  <server name="${escape(entry.name)}" description="${escape(entry.description)}" />`,
    ),
    "</mcp_servers_on_demand>",
  ].join("\n")
}

export function visible(cfg: Config.Info, networkRestricted: boolean): boolean {
  if (networkRestricted) return false
  return Object.values(cfg.mcp ?? {}).some((value) => isEligible(value))
}

export function disconnectable(cfg: Config.Info, name: string): { ok: true } | { ok: false; reason: string } {
  const value = cfg.mcp?.[name]
  if (!value || typeof value !== "object") return { ok: false, reason: `MCP server "${name}" is unknown.` }
  if (!isConfigured(value)) return { ok: false, reason: `MCP server "${name}" is not fully configured.` }
  if (value.on_demand !== true) {
    return { ok: false, reason: `MCP server "${name}" is not on demand; the session manages its lifecycle.` }
  }
  return { ok: true }
}

export function connectable(cfg: Config.Info, name: string): { ok: true } | { ok: false; reason: string } {
  const value = cfg.mcp?.[name]
  if (!value || typeof value !== "object") return { ok: false, reason: `MCP server "${name}" is unknown.` }
  if (!isConfigured(value)) {
    return { ok: false, reason: `MCP server "${name}" is not fully configured.` }
  }
  if (value.enabled === false) return { ok: false, reason: `MCP server "${name}" is disabled.` }
  if (value.on_demand !== true) {
    return { ok: false, reason: `MCP server "${name}" is not on demand and already starts with the session.` }
  }
  return { ok: true }
}
