import { describe, expect, it } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type Favorite = { providerID: string; modelID: string }

type Internals = {
  reorderFavorite: (next: Favorite[]) => Promise<void>
}

function connection(notified: Favorite[][]) {
  return {
    connect: async () => {},
    getClient: () => ({}) as never,
    onEventFiltered: () => () => undefined,
    onStateChange: () => () => undefined,
    onNotificationDismissed: () => () => undefined,
    onClearPendingPrompts: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    unregisterVisible: () => undefined,
    unregisterAttached: () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    notifyFavoritesChanged: (favorites: Favorite[]) => notified.push(favorites),
  }
}

function context(initial: Favorite[]) {
  const state = new Map<string, unknown>([["favoriteModels", initial]])
  return {
    state,
    ctx: {
      globalState: {
        get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
        update: async (key: string, value: unknown) => {
          state.set(key, value)
        },
      },
    },
  }
}

function setup(initial: Favorite[]) {
  const notified: Favorite[][] = []
  const { ctx, state } = context(initial)
  const provider = new KiloProvider({} as never, connection(notified) as never, ctx as never)
  return { internal: provider as unknown as Internals, notified, state }
}

const favorites: Favorite[] = [
  { providerID: "kilo", modelID: "claude" },
  { providerID: "kilo", modelID: "gpt" },
  { providerID: "kilo", modelID: "gemini" },
]

describe("KiloProvider favorite reordering", () => {
  it("persists a reordering sent by the webview and broadcasts it", async () => {
    const { internal, notified, state } = setup(favorites)

    await internal.reorderFavorite([favorites[1]!, favorites[0]!, favorites[2]!])

    expect(state.get("favoriteModels")).toEqual([favorites[1]!, favorites[0]!, favorites[2]!])
    expect(notified).toEqual([[favorites[1]!, favorites[0]!, favorites[2]!]])
  })

  it("keeps the stored order when the sent list is stale", async () => {
    const { internal, notified, state } = setup(favorites)

    await internal.reorderFavorite([favorites[0]!, favorites[1]!])

    expect(state.get("favoriteModels")).toEqual(favorites)
    expect(notified).toEqual([favorites])
  })

  it("keeps the stored order when the sent list duplicates an entry", async () => {
    const { internal, notified, state } = setup(favorites)

    await internal.reorderFavorite([favorites[0]!, favorites[1]!, favorites[1]!])

    expect(state.get("favoriteModels")).toEqual(favorites)
    expect(notified).toEqual([favorites])
  })
})
