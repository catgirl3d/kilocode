import { describe, expect, it } from "bun:test"
import { KiloProvider } from "../../src/KiloProvider"

type Handler = (message: Record<string, unknown>) => Promise<void>

describe("KiloProvider variant persistence", () => {
  const setup = (context: unknown) => {
    const provider = new KiloProvider(
      {} as never,
      {
        onSessionAcknowledged: () => () => undefined,
        unregisterVisible: () => undefined,
        unregisterAttached: () => undefined,
      } as never,
      context as never,
    )
    const internal = provider as unknown as {
      webview: unknown
      setupWebviewMessageHandler: (webview: unknown) => void
    }
    const ready = Promise.withResolvers<Handler>()
    const sent: unknown[] = []
    const webview = {
      postMessage: async (message: unknown) => {
        sent.push(message)
        return true
      },
      onDidReceiveMessage: (handler: Handler) => {
        ready.resolve(handler)
        return { dispose: () => undefined }
      },
    }
    internal.webview = webview
    internal.setupWebviewMessageHandler(webview)
    return { provider, receive: ready.promise, sent }
  }

  it("waits for a pending variant write before serving a reload from another provider", async () => {
    const state = new Map<string, Record<string, string>>([["variantSelections", {}]])
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const context = {
      globalState: {
        get: (key: string, fallback?: unknown) => {
          if (key !== "variantSelections") return fallback
          return { ...(state.get(key) ?? {}) }
        },
        update: async (key: string, value: unknown) => {
          if (key !== "variantSelections") return
          started.resolve()
          await release.promise
          state.set(key, { ...(value as Record<string, string>) })
        },
      },
    }
    const writer = setup(context)
    const reader = setup(context)
    const write = await writer.receive
    const read = await reader.receive

    const persist = write({ type: "persistVariant", key: "agent/code/kilo/personal", value: "high" })
    await started.promise
    const request = read({ type: "requestVariants" })
    await Bun.sleep(0)
    release.resolve()
    await Promise.all([persist, request])

    expect(reader.sent).toContainEqual({
      type: "variantsLoaded",
      variants: { "agent/code/kilo/personal": "high" },
    })

    writer.provider.dispose()
    reader.provider.dispose()
  })
})
