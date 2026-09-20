// fork_change - new file
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import * as McpOnDemand from "@/kilocode/mcp/on-demand"
import { Tool } from "@/tool/tool"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Effect, Schema } from "effect"

const Params = Schema.Struct({
  action: Schema.Literals(["list", "connect", "disconnect"]).annotate({
    description: "List servers, connect an on-demand server, or disconnect one.",
  }),
  name: Schema.optional(Schema.String.annotate({ description: "The MCP server name for connect or disconnect." })),
})

type Meta = {
  action: "list" | "connect" | "disconnect"
  ok: boolean
  server?: string
  status?: string
}

export const McpTool = Tool.define<typeof Params, Meta, MCP.Service | Config.Service, "mcp">(
  "mcp",
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const locks = KeyedMutex.makeUnsafe<string>()

    return {
      description:
        "Use list to report every known MCP server and its status. Use connect only for servers configured with on_demand: true. After a successful connect, native tools become available on the next step. Use disconnect to release a connected on-demand server and remove its native tools from later steps. Unknown, incomplete, disabled, or non-on-demand servers return clear errors.",
      parameters: Params,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (params.action === "list") {
            const statuses = yield* mcp.status()
            const names = new Set([
              ...Object.keys(cfg.mcp ?? {}).filter((name) => McpOnDemand.isConfigured(cfg.mcp?.[name])),
              ...Object.keys(statuses),
            ])
            const items = Array.from(names)
              .map((name) => {
                const value = cfg.mcp?.[name]
                const entry = McpOnDemand.isConfigured(value) ? value : undefined
                return {
                  name,
                  status: statuses[name]?.status ?? "disabled",
                  ...(typeof entry?.description === "string" && entry.description.trim()
                    ? { description: entry.description }
                    : {}),
                  on_demand: entry?.on_demand === true,
                }
              })
              .sort((a, b) => a.name.localeCompare(b.name))
            return {
              title: "MCP servers",
              output: JSON.stringify(items, null, 2),
              metadata: { action: "list", ok: true } satisfies Meta,
            }
          }

          if (!params.name?.trim()) {
            return {
              title: params.action === "disconnect" ? "MCP disconnect failed" : "MCP connect failed",
              output: "A server name is required.",
              metadata: { action: params.action, ok: false } satisfies Meta,
            }
          }
          const name = params.name.trim()
          if (params.action === "disconnect") {
            return yield* locks.withLock(name)(
              Effect.gen(function* () {
                const result = McpOnDemand.disconnectable(cfg, name)
                if (!result.ok) {
                  return {
                    title: "MCP disconnect failed",
                    output: result.reason,
                    metadata: { action: "disconnect", ok: false, server: name } satisfies Meta,
                  }
                }
                const statuses = yield* mcp.status()
                if (statuses[name]?.status === "disabled") {
                  return {
                    title: "MCP already disconnected",
                    output: `MCP server "${name}" is not connected.`,
                    metadata: { action: "disconnect", ok: true, server: name } satisfies Meta,
                  }
                }
                yield* ctx.ask({
                  permission: "mcp",
                  patterns: [name],
                  always: [name],
                  metadata: { action: "disconnect", server: name },
                })
                const disconnected = yield* mcp.disconnect(name).pipe(
                  Effect.match({
                    onFailure: (error) => ({ ok: false as const, error: String(error) }),
                    onSuccess: () => ({ ok: true as const }),
                  }),
                )
                if (!disconnected.ok) {
                  return {
                    title: "MCP disconnect failed",
                    output: `MCP server "${name}" could not be disconnected: ${disconnected.error}`,
                    metadata: { action: "disconnect", ok: false, server: name } satisfies Meta,
                  }
                }
                const current = (yield* mcp.status())[name] ?? { status: "disabled" as const }
                if (current.status !== "disabled") {
                  const error = "error" in current ? ` Error: ${current.error}.` : ""
                  return {
                    title: "MCP disconnect failed",
                    output: `MCP server "${name}" could not be disconnected.${error}`,
                    metadata: { action: "disconnect", ok: false, server: name, status: current.status } satisfies Meta,
                  }
                }
                return {
                  title: "MCP disconnected",
                  output: `MCP server "${name}" is disconnected. Its native tools are no longer available.`,
                  metadata: { action: "disconnect", ok: true, server: name, status: "disabled" } satisfies Meta,
                }
              }),
            )
          }
          return yield* locks.withLock(name)(
            Effect.gen(function* () {
              const result = McpOnDemand.connectable(cfg, name)
              if (!result.ok) {
                return {
                  title: "MCP connect failed",
                  output: result.reason,
                  metadata: { action: "connect", ok: false, server: name } satisfies Meta,
                }
              }

              const statuses = yield* mcp.status()
              if (statuses[name]?.status === "connected") {
                return {
                  title: "MCP already connected",
                  output: `MCP server "${name}" is already connected.`,
                  metadata: { action: "connect", ok: true, server: name, status: "connected" } satisfies Meta,
                }
              }

              yield* ctx.ask({
                permission: "mcp",
                patterns: [name],
                always: [name],
                metadata: { action: "connect", server: name },
              })
              yield* mcp
                .connect(name)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("MCP connect failed", { server: name, error: String(error) }),
                  ),
                )
              const current = (yield* mcp.status())[name] ?? { status: "disabled" as const }
              if (current.status === "connected") {
                return {
                  title: "MCP connected",
                  output: `MCP server "${name}" status: connected. Its native tools become available on the next step.`,
                  metadata: { action: "connect", ok: true, server: name, status: "connected" } satisfies Meta,
                }
              }
              if (current.status === "needs_auth") {
                return {
                  title: "MCP connect failed",
                  output: `MCP server "${name}" needs OAuth authentication and cannot be connected yet. Run \`kilo mcp auth ${name}\` in the CLI or complete the MCP OAuth flow in the UI. Do not retry connect before authentication is completed.`,
                  metadata: { action: "connect", ok: false, server: name, status: current.status } satisfies Meta,
                }
              }
              const error = "error" in current ? ` Error: ${current.error}.` : ""
              const registration =
                current.status === "needs_client_registration"
                  ? " Fix client registration (clientId) in the server config before retrying."
                  : ""
              return {
                title: "MCP connect failed",
                output: `MCP server "${name}" connection status: ${current.status}.${error}${registration}`,
                metadata: { action: "connect", ok: false, server: name, status: current.status } satisfies Meta,
              }
            }),
          )
        }),
    }
  }),
)
