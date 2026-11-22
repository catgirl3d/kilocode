import { describe, expect, it } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  postMessage: (message: unknown) => void
  providersRetry: boolean
  cachedProvidersMessage: unknown
  cachedProvidersDirectory: string | null
  cachedConfigMessage: unknown
  cachedConfigDirectory: string | null
  retryInitialization: () => Promise<void>
  refreshConfig: (type: "configLoaded" | "configUpdated", dir?: string) => Promise<void>
  initializeConnection: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  sendProviders: () => Promise<void>
  attachToWebview: (webview: never) => void
  fetchAndSendIndexingStatus: (directory?: string, projectId?: string) => void
  flushPendingKiloModel: () => void
  checkConfigWarnings: (reason: string) => Promise<void>
  syncWebviewState: (reason: string) => Promise<void>
  flushPendingSessionRefresh: (reason: string) => Promise<void>
  recoverPendingPrompts: () => void
  fetchAndSendAgents: () => Promise<void>
  fetchAndSendSkills: () => Promise<void>
  fetchAndSendCommands: () => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendNotifications: () => Promise<void>
  seedSessionStatusMap: () => Promise<void>
  sendNotificationSettings: () => void
  startStatsPolling: () => void
}

function connection(online = true, custom?: unknown) {
  let listener: ((state: State, error?: Error) => void) | undefined
  const client = custom ?? { kilo: { profile: async () => ({ data: null }) } }
  return {
    emitState(next: State) {
      if (!listener) throw new Error("expected a connection state subscription")
      listener(next)
    },
    connect: async () => {},
    getClient: () => {
      if (!online) throw new Error("Not connected — call connect() first")
      return client as never
    },
    onEventFiltered: () => () => undefined,
    fetchProviders: (_dir: string, load: () => Promise<unknown>) => load(),
    onStateChange: (next: typeof listener) => {
      listener = next
      return () => undefined
    },
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
  }
}

function provider(service: ReturnType<typeof connection>, root = () => "/repo") {
  return new KiloProvider({} as never, service as never, undefined, {
    rootDirectory: root,
  }) as unknown as Internals
}

function stub(internal: Internals) {
  internal.webview = { postMessage: async () => true }
  internal.fetchAndSendIndexingStatus = () => {}
  internal.flushPendingKiloModel = () => {}
  internal.checkConfigWarnings = async () => {}
  internal.syncWebviewState = async () => {}
  internal.flushPendingSessionRefresh = async () => {}
  internal.recoverPendingPrompts = () => {}
  internal.fetchAndSendAgents = async () => {}
  internal.fetchAndSendSkills = async () => {}
  internal.fetchAndSendCommands = async () => {}
  internal.fetchAndSendConfig = async () => {}
  internal.fetchAndSendNotifications = async () => {}
  internal.seedSessionStatusMap = async () => {}
  internal.sendNotificationSettings = () => {}
  internal.startStatsPolling = () => {}
}

function kind(message: unknown) {
  return message && typeof message === "object" && "type" in message ? message.type : undefined
}

async function attach(internal: Internals) {
  const messages: unknown[] = []
  const loaded = Promise.withResolvers<unknown>()
  const handler = Promise.withResolvers<(message: Record<string, unknown>) => Promise<void>>()
  internal.attachToWebview({
    postMessage: async (message: unknown) => {
      messages.push(message)
      if (kind(message) === "providersLoaded") loaded.resolve(message)
      return true
    },
    onDidReceiveMessage: (fn: (message: Record<string, unknown>) => Promise<void>) => {
      handler.resolve(fn)
      return { dispose: () => {} }
    },
  } as never)
  return { messages, loaded: loaded.promise, send: await handler.promise }
}

describe("KiloProvider providers on reconnect", () => {
  it("recovers providers against the selected project without reconnecting", async () => {
    let dir = "/unavailable"
    const requests: string[] = []
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        provider: {
          list: async (input: { directory: string }) => {
            requests.push(input.directory)
            if (input.directory === "/unavailable") throw new Error("PermissionDenied")
            return { data: { all: [], connected: [], default: {} } }
          },
        },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const configs: string[] = []
    internal.fetchAndSendConfig = async () => {
      configs.push(dir)
      internal.cachedConfigMessage = { type: "configLoaded", config: {} }
      internal.cachedConfigDirectory = dir
    }
    await internal.fetchAndSendProviders()
    expect(internal.providersRetry).toBe(true)

    dir = "/healthy"
    await internal.retryInitialization()

    expect(requests).toEqual(["/unavailable", "/healthy"])
    expect(configs).toEqual(["/healthy"])
    expect(internal.providersRetry).toBe(false)
    expect(messages).toContainEqual(expect.objectContaining({ type: "providersLoaded", ready: true }))

    await internal.retryInitialization()
    expect(requests).toHaveLength(2)
    expect(configs).toHaveLength(1)
  })

  it("drops a config snapshot that resolves for a previous project directory", async () => {
    let dir = "/project-a"
    const messages: unknown[] = []
    const internal = provider(
      connection(true, {
        config: {
          get: async () => ({ data: {} }),
          overlay: async () => ({ data: { collections: [] } }),
        },
        global: { config: { get: async () => ({ data: {} }) } },
        experimental: { capabilities: { get: async () => ({ data: { backgroundSubagents: false } }) } },
      }),
      () => dir,
    )
    stub(internal)
    internal.webview = { postMessage: async (message) => messages.push(message) }

    await internal.refreshConfig("configLoaded", "/project-a")
    expect(messages).toContainEqual(expect.objectContaining({ type: "configLoaded" }))
    const published = messages.length

    dir = "/project-b"
    await internal.refreshConfig("configLoaded", "/project-a")

    expect(messages).toHaveLength(published)
  })

  it("marks a retry when providers are fetched without a client", async () => {
    const internal = provider(connection(false))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("marks a retry when the provider fetch rejects with a client", async () => {
    const reject = {
      kilo: { authStatus: async () => ({ data: undefined }) },
      provider: {
        list: async () => {
          throw new Error("backend gone")
        },
      },
    }
    const internal = provider(connection(true, reject))
    stub(internal)

    await internal.fetchAndSendProviders()

    expect(internal.providersRetry).toBe(true)
  })

  it("fetches providers on connect when a previous fetch had no client", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    internal.providersRetry = true
    const before = providers

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(before + 1)
  })

  it("fetches providers before extensionDataReady when the early request had no client", async () => {
    const service = connection()
    const internal = provider(service)
    const events: string[] = []
    stub(internal)
    internal.providersRetry = true
    internal.fetchAndSendProviders = async () => {
      events.push("providers")
      internal.providersRetry = false
    }
    internal.postMessage = (message) => {
      if (message && typeof message === "object" && "type" in message && message.type === "extensionDataReady")
        events.push("ready")
    }

    await internal.initializeConnection()

    expect(events).toEqual(["providers", "ready"])
  })

  it("fetches again for a joined request when a client change discards the in-flight run", async () => {
    const lists: string[] = []
    const gate = Promise.withResolvers<void>()
    const backend = (name: string, wait?: Promise<void>) => ({
      kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
      provider: {
        list: async () => {
          lists.push(name)
          if (wait) await wait
          return { data: { all: [], connected: [], default: {} } }
        },
      },
    })
    const service = connection(true, backend("old", gate.promise))
    const internal = provider(service)
    stub(internal)
    const messages: unknown[] = []
    internal.webview = { postMessage: async (message) => messages.push(message) }

    const run = internal.fetchAndSendProviders()
    await Bun.sleep(0)
    const join = internal.sendProviders()
    const next = backend("new")
    service.getClient = () => next as never
    gate.resolve()
    await Promise.all([run, join])

    expect(lists).toEqual(["old", "new"])
    expect(messages.filter((message) => (message as { type?: string }).type === "providersLoaded")).toHaveLength(1)
  })

  it("reloads providers when the user retries the connection", async () => {
    const service = { ...connection(), resume: () => {}, onSessionAcknowledged: () => () => undefined }
    const internal = provider(service)
    stub(internal)
    await internal.initializeConnection()
    const reload = Promise.withResolvers<void>()
    internal.fetchAndSendProviders = async () => reload.resolve()
    const view = await attach(internal)

    await view.send({ type: "retryConnection" })

    await reload.promise
  })

  it("replays cached providers for a webview request", async () => {
    let calls = 0
    const service = {
      ...connection(true, {
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        provider: {
          list: async () => {
            calls += 1
            return { data: { all: [], connected: [], default: {} } }
          },
        },
      }),
      onSessionAcknowledged: () => () => undefined,
    }
    const internal = provider(service)
    stub(internal)
    internal.cachedProvidersMessage = {
      type: "providersLoaded",
      providers: {},
      connected: [],
      defaults: {},
      ready: true,
    }
    internal.cachedProvidersDirectory = "/repo"
    const view = await attach(internal)

    await view.send({ type: "requestProviders" })

    expect(await view.loaded).toBe(internal.cachedProvidersMessage)
    expect(view.messages.filter((message) => kind(message) === "providersLoaded")).toHaveLength(1)
    expect(calls).toBe(0)
  })

  it("fetches providers instead of replaying a cache from another directory", async () => {
    let calls = 0
    const internal = provider(
      connection(true, {
        kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
        provider: {
          list: async () => {
            calls += 1
            return { data: { all: [], connected: [], default: {} } }
          },
        },
      }),
    )
    stub(internal)
    const messages: unknown[] = []
    internal.webview = { postMessage: async (message) => messages.push(message) }
    const stale = { type: "providersLoaded", providers: {}, connected: [], defaults: {}, ready: true }
    internal.cachedProvidersMessage = stale
    internal.cachedProvidersDirectory = "/other"

    await internal.sendProviders()

    const loaded = messages.filter((message) => kind(message) === "providersLoaded")
    expect(calls).toBe(1)
    expect(loaded).toHaveLength(1)
    expect(loaded.at(0)).not.toBe(stale)
  })

  it("does not refetch providers on connect when none are pending", async () => {
    const service = connection()
    const internal = provider(service)
    let providers = 0
    stub(internal)
    internal.fetchAndSendProviders = async () => {
      providers++
    }
    await internal.initializeConnection()
    expect(providers).toBe(0)

    service.emitState("connected")
    await Bun.sleep(0)

    expect(providers).toBe(0)
  })
})
