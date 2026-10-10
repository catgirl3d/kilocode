import { describe, expect, it, mock } from "bun:test"
import type { MarketplaceItem } from "../../src/services/marketplace/types"
import { mcpAuth } from "../../src/services/mcp-auth"

const { MarketplacePanelProvider } = await import("../../src/MarketplacePanelProvider")

interface Internals {
  handle(message: { type?: string }): Promise<void>
  remove(item: MarketplaceItem, scope: "project" | "global"): Promise<void>
  marketplace: { remove: (...args: unknown[]) => Promise<{ success: boolean; slug: string; error?: string }> }
}

type Calls = Array<{ type: "resume" | "connect"; directory?: string }>

function panel() {
  const calls: Calls = []
  const connection = {
    getClient: () => undefined,
    getClientAsync: async () => ({}),
    connect: async (directory: string) => {
      calls.push({ type: "connect", directory })
    },
    resume: () => {
      calls.push({ type: "resume" })
    },
    onStateChange: () => () => {},
    onLanguageChanged: () => () => {},
    onEventFiltered: () => () => {},
  }
  const provider = new MarketplacePanelProvider({} as never, connection as never, {} as never)
  const internal = provider as unknown as Internals
  internal.marketplace.remove = mock(async () => ({ success: true, slug: "anaconda" }))
  return { internal, connection, calls, provider }
}

/**
 * install() already refreshes the shared McpAuthService so a newly installed
 * server's needs-auth state reaches every provider via its onChange
 * broadcast. remove() must mirror that so a removed server's stale
 * needs-auth state clears the same way — see the bug where uninstalling an
 * MCP server left its session-issues warning icon stuck.
 */
describe("MarketplacePanelProvider MCP removal auth refresh", () => {
  it("refreshes the shared MCP auth service after removing an MCP server", async () => {
    const { internal, connection } = panel()
    const refresh = mock(async () => [] as string[])
    mcpAuth(connection as never).refresh = refresh
    const item = { id: "anaconda", type: "mcp" } as MarketplaceItem

    await internal.remove(item, "global")

    expect(refresh).toHaveBeenCalledWith("/repo")
  })

  it("does not refresh MCP auth when removal fails", async () => {
    const { internal, connection } = panel()
    internal.marketplace.remove = mock(async () => ({ success: false, slug: "anaconda", error: "boom" }))
    const refresh = mock(async () => [] as string[])
    mcpAuth(connection as never).refresh = refresh
    const item = { id: "anaconda", type: "mcp" } as MarketplaceItem

    await internal.remove(item, "global")

    expect(refresh).not.toHaveBeenCalled()
  })

  it("does not refresh MCP auth for non-MCP item types", async () => {
    const { internal, connection } = panel()
    const refresh = mock(async () => [] as string[])
    mcpAuth(connection as never).refresh = refresh
    const item = { id: "my-skill", type: "skill" } as MarketplaceItem

    await internal.remove(item, "global")

    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("MarketplacePanelProvider retry host handler", () => {
  it("resumes the connection hold before connecting the panel directory", async () => {
    const { internal, calls, provider } = panel()

    try {
      await internal.handle({ type: "retryConnection" })

      expect(calls).toEqual([{ type: "resume" }, { type: "connect", directory: "/repo" }])
    } finally {
      provider.dispose()
    }
  })
})
