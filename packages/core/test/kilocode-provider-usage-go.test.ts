import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { ProviderUsage } from "../src/kilocode/provider-usage"
import { PluginV2 } from "../src/plugin"
import { ProviderV2 } from "../src/provider"

const provider = ProviderV2.ID.make("opencode-go")
const integration = Integration.ID.make("opencode-go")
const credentialID = Credential.ID.make("cred_opencode_go")
const api = "https://opencode.ai/inference/go/openai/v1"
const usageUrl = "https://opencode.ai/inference/go/v1/usage"

type ResponseValue = Response | Error

type State = {
  credential?: Credential.Value
  connected: boolean
  configuredKey?: string
  disabled?: boolean
  resolutionFailure?: boolean
  url?: string
  responses: ResponseValue[]
  requests: Array<{ url: string; init: RequestInit }>
}

const usage = (rolling: number, weekly = 7, monthly = 3) =>
  Response.json({
    usage: {
      rolling: { status: "ok", percent: rolling, resetsAt: "2026-08-12T05:00:00.000Z" },
      weekly: { status: "ok", percent: weekly, resetsAt: "2026-08-19T00:00:00.000Z" },
      monthly: { status: "ok", percent: monthly, resetsAt: "2026-09-01T00:00:00.000Z" },
    },
  })

const catalog = (state: State) =>
  Layer.mock(Catalog.Service)({
    provider: {
      get: () => Effect.succeed(undefined),
      all: () =>
        Effect.succeed([
          ProviderV2.Info.make({
            id: provider,
            name: "OpenCode Go",
            integrationID: integration,
            disabled: state.disabled,
            api: { type: "native", url: state.url ?? api, settings: {} },
            request: {
              headers: {},
              body: state.configuredKey ? { apiKey: state.configuredKey } : {},
            },
          }),
        ]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(undefined),
      small: () => Effect.succeed(undefined),
    },
  })

const integrations = (state: State) =>
  Layer.mock(Integration.Service)({
    connection: {
      active: (id) =>
        Effect.sync(() =>
          id === integration && state.connected
            ? { type: "credential" as const, id: credentialID, label: "OpenCode Go" }
            : undefined,
        ),
      resolve: () =>
        state.resolutionFailure
          ? Effect.fail(new Integration.AuthorizationError({ cause: "private credential failure" }))
          : Effect.succeed(state.credential),
      key: () => Effect.void,
      oauth: () => Effect.die("unused"),
      update: () => Effect.void,
      remove: () => Effect.void,
    },
    attempt: {
      status: () => Effect.die("unused"),
      complete: () => Effect.void,
      cancel: () => Effect.void,
    },
  })

const transport = (state: State) =>
  Layer.succeed(ProviderUsage.Transport, {
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        state.requests.push({ url, init: init ?? {} })
        const next = state.responses.shift()
        if (next instanceof Error) throw next
        return next ?? usage(50)
      },
      { preconnect: fetch.preconnect },
    ),
    plans: async () => [],
    byok: async () => [],
    usage: async () => {
      throw new Error("unused")
    },
  })

const plugins = Layer.mock(PluginV2.Service)({
  add: () => Effect.void,
  remove: () => Effect.void,
  wait: () => Effect.void,
})

const layer = (state: State) =>
  Layer.fresh(ProviderUsage.layer).pipe(
    Layer.provide(catalog(state)),
    Layer.provide(integrations(state)),
    Layer.provide(transport(state)),
    Layer.provide(plugins),
  )

const withUsage = Effect.fn("OpenCodeGoProviderUsageTest.withUsage")(function* (state: State) {
  const scope = yield* Scope.make()
  const service = Context.get(yield* Layer.buildWithScope(layer(state), scope), ProviderUsage.Service)
  return { scope, service }
})

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void)

const key = (value: string): Credential.Key => Credential.Key.make({ type: "key", key: value })

const state = (input: Partial<State> = {}): State => ({
  connected: false,
  responses: [],
  requests: [],
  ...input,
})

describe("OpenCode Go provider usage service", () => {
  test("uses a configured provider credential and returns three usage windows", async () => {
    const current = state({
      connected: true,
      credential: key("stored-key"),
      configuredKey: "config-key",
      responses: [usage(17)],
    })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    const result = await Effect.runPromise(service.get())
    const headers = new Headers(current.requests[0]?.init.headers)

    expect(current.requests).toHaveLength(1)
    expect(current.requests[0]?.url).toBe(usageUrl)
    expect(headers.get("authorization")).toBe("Bearer stored-key")
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ providerID: "opencode-go" })
    expect(result.items[0]?.windows[0]).toMatchObject({ used: 17 })
    expect(result.items[0]?.windows).toHaveLength(3)
    await Effect.runPromise(close(scope))
  })

  test("uses the OAuth access token for an OAuth provider credential", async () => {
    const current = state({
      connected: true,
      credential: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("oauth"),
        access: "oauth-key",
        refresh: "oauth-refresh",
        expires: Date.now() + 60_000,
      }),
      responses: [usage(23)],
    })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    const result = await Effect.runPromise(service.get())
    const headers = new Headers(current.requests[0]?.init.headers)

    expect(headers.get("authorization")).toBe("Bearer oauth-key")
    expect(result.items[0]).toMatchObject({ providerID: "opencode-go", fetchState: "ready" })
    await Effect.runPromise(close(scope))
  })

  test("falls back to a provider configured key when no connection exists", async () => {
    const current = state({ configuredKey: "configured-key", responses: [usage(21)] })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    const result = await Effect.runPromise(service.get())
    const headers = new Headers(current.requests[0]?.init.headers)

    expect(current.requests).toHaveLength(1)
    expect(headers.get("authorization")).toBe("Bearer configured-key")
    expect(result.items[0]?.fetchState).toBe("ready")
    await Effect.runPromise(close(scope))
  })

  test("does not fetch or emit a snapshot without a key", async () => {
    const current = state()
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(0)
    await Effect.runPromise(close(scope))
  })

  test("does not fetch or emit a snapshot for a disabled provider", async () => {
    const current = state({ disabled: true, configuredKey: "configured-key" })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(0)
    await Effect.runPromise(close(scope))
  })

  test("does not send a key for a custom provider URL", async () => {
    const current = state({ url: "https://example.com/v1", configuredKey: "configured-key" })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(0)
    await Effect.runPromise(close(scope))
  })

  test("keeps previous windows stale after a retryable refresh failure", async () => {
    const current = state({
      connected: true,
      credential: key("stored-key"),
      responses: [usage(17), new Error("private network")],
    })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    const ready = await Effect.runPromise(service.get())
    const stale = await Effect.runPromise(service.refresh())

    expect(ready.items[0]).toMatchObject({ fetchState: "ready" })
    expect(ready.items[0]?.windows[0]).toMatchObject({ used: 17 })
    expect(stale.items[0]).toMatchObject({ fetchState: "stale" })
    expect(stale.items[0]?.windows[0]).toMatchObject({ used: 17 })
    expect(JSON.stringify(stale)).not.toContain("private network")
    await Effect.runPromise(close(scope))
  })

  test("does not retain old windows after a non-retryable auth refresh failure", async () => {
    const current = state({
      connected: true,
      credential: key("stored-key"),
      responses: [usage(17), new Response("private auth", { status: 401 })],
    })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    await Effect.runPromise(service.get())
    const failed = await Effect.runPromise(service.refresh())

    expect(failed.items[0]).toMatchObject({ fetchState: "unavailable", windows: [] })
    expect(JSON.stringify(failed)).not.toContain("private auth")
    await Effect.runPromise(close(scope))
  })

  test("refetches and isolates usage when the credential changes", async () => {
    const current = state({ connected: true, credential: key("key-a") })
    current.responses = [usage(10), usage(70)]
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items[0]?.windows[0]?.used).toBe(10)
    current.credential = key("key-b")
    const changed = await Effect.runPromise(service.get())

    expect(changed.items[0]?.windows[0]?.used).toBe(70)
    expect(current.requests).toHaveLength(2)
    expect(new Headers(current.requests[1]?.init.headers).get("authorization")).toBe("Bearer key-b")
    await Effect.runPromise(close(scope))
  })

  test("removes the snapshot when the configured key is removed", async () => {
    const current = state({ connected: true, credential: key("stored-key"), responses: [usage(17)] })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toHaveLength(1)
    current.connected = false
    current.credential = undefined
    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(1)
    await Effect.runPromise(close(scope))
  })

  test("preserves stale usage when credential resolution fails", async () => {
    const current = state({
      connected: true,
      credential: key("stored-key"),
      configuredKey: "configured-key",
      responses: [usage(17)],
    })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items[0]?.fetchState).toBe("ready")
    current.resolutionFailure = true
    const failed = await Effect.runPromise(service.get())

    expect(failed.items[0]).toMatchObject({ fetchState: "stale" })
    expect(failed.items[0]?.windows[0]).toMatchObject({ used: 17 })
    expect(current.requests).toHaveLength(1)
    await Effect.runPromise(close(scope))
  })

  test("prunes the snapshot when the provider becomes disabled", async () => {
    const current = state({ connected: true, credential: key("stored-key"), responses: [usage(17)] })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toHaveLength(1)
    current.disabled = true
    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(1)
    await Effect.runPromise(close(scope))
  })

  test("prunes the snapshot when the provider URL becomes ineligible", async () => {
    const current = state({ connected: true, credential: key("stored-key"), responses: [usage(17)] })
    const { scope, service } = await Effect.runPromise(withUsage(current))

    expect((await Effect.runPromise(service.get())).items).toHaveLength(1)
    current.url = "https://example.com/v1"
    expect((await Effect.runPromise(service.get())).items).toEqual([])
    expect(current.requests).toHaveLength(1)
    await Effect.runPromise(close(scope))
  })
})
