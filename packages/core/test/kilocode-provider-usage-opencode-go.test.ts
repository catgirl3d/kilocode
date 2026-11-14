import { describe, expect, test } from "bun:test"
import { base, decode, load, normalize, query } from "../src/kilocode/provider-usage/opencode-go"

const limit = 64 * 1024
const url = "https://opencode.ai/zen/go/v1/usage"
const candidate = { label: "OpenCode Go", key: "go-secret", url }
const fetchedAt = "2026-08-12T00:00:00.000Z"

const payload = (usage: Record<string, unknown> = {}) => ({ usage })

const response = (body: unknown, status = 200, headers?: HeadersInit) => {
  const value = new Headers(headers)
  value.set("content-type", "application/json")
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: value })
}

const thrown = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error("Expected the operation to fail")
}

const fetcher = (run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect: fetch.preconnect })

describe("OpenCode Go usage URL discovery", () => {
  for (const path of ["/zen/go/v1", "/zen/go/v1/", "/zen/go/v1///", "/inference/go/v1", "/inference/go/v1/"]) {
    test(`accepts ${path}`, () => {
      expect(base(`https://opencode.ai${path}`)).toBe(`https://opencode.ai${path.replace(/\/+$/, "")}/usage`)
    })
  }

  for (const path of ["/inference/go/openai/v1", "/inference/go/anthropic/v1", "/inference/go/openai/v1/"]) {
    test(`canonicalizes ${path}`, () => {
      expect(base(`https://opencode.ai${path}`)).toBe("https://opencode.ai/inference/go/v1/usage")
    })
  }

  for (const value of [
    "http://opencode.ai/zen/go/v1",
    "https://example.com/zen/go/v1",
    "https://user:pass@opencode.ai/zen/go/v1",
    "https://opencode.ai/zen/go/v1?key=value",
    "https://opencode.ai/zen/go/v1?",
    "https://opencode.ai/zen/go/v1#fragment",
    "https://opencode.ai/zen/go/v1#",
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/inference/v1",
    "https://opencode.ai/go/v1",
    "https://opencode.ai/inference/go",
    "https://opencode.ai/inference/go/",
    "https://opencode.ai.evil/zen/go/v1",
  ]) {
    test(`rejects ${value}`, () => {
      expect(base(value)).toBeUndefined()
    })
  }

  test("does not throw for malformed input", () => {
    expect(base("not a URL")).toBeUndefined()
  })
})

describe("OpenCode Go usage transport", () => {
  test("sends the bounded JSON request with the bearer key and installation user agent", async () => {
    let seen: { input: string | URL | Request; init?: RequestInit } | undefined
    await query(
      url,
      "secret-key",
      fetcher(async (input, init) => {
        seen = { input, init }
        return response(payload({ monthly: { percent: 3, status: "ok" } }))
      }),
    )

    expect(seen?.input).toBe(url)
    expect(seen?.init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" })
    expect(seen?.init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(seen?.init?.headers)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("authorization")).toBe("Bearer secret-key")
    expect(headers.get("user-agent")).toMatch(/^kilo\//)
  })

  for (const status of [401, 403]) {
    test(`maps HTTP ${status} to an auth failure`, async () => {
      const error = await thrown(() =>
        query(
          url,
          "secret-key",
          fetcher(async () => response("private auth", status)),
        ),
      )

      expect(error).toMatchObject({ code: "auth" })
      expect(String(error)).not.toContain("private auth")
    })
  }

  test("maps other non-success responses to an HTTP failure without the body", async () => {
    const error = await thrown(() =>
      query(
        url,
        "secret-key",
        fetcher(async () => response("private http", 500)),
      ),
    )

    expect(error).toMatchObject({ code: "http" })
    expect(String(error)).not.toContain("private http")
  })

  test("maps fetch rejection to a network failure without the rejection text", async () => {
    const error = await thrown(() =>
      query(
        url,
        "secret-key",
        fetcher(async () => {
          throw new Error("private network detail")
        }),
      ),
    )

    expect(error).toMatchObject({ code: "network" })
    expect(String(error)).not.toContain("private network detail")
  })

  test("maps invalid JSON to an invalid failure", async () => {
    const error = await thrown(() =>
      query(
        url,
        "secret-key",
        fetcher(async () => response("not-json private")),
      ),
    )

    expect(error).toMatchObject({ code: "invalid" })
    expect(String(error)).not.toContain("not-json private")
  })

  for (const kind of ["declared", "streamed"] as const) {
    test(`rejects ${kind} bodies over 64 KiB without exposing their contents`, async () => {
      const secret = `${kind}-private-body`
      const body =
        kind === "declared"
          ? response(secret, 200, { "content-length": String(limit + 1) })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(secret))
                  controller.enqueue(new Uint8Array(limit))
                  controller.close()
                },
              }),
            )
      const error = await thrown(() =>
        query(
          url,
          "secret-key",
          fetcher(async () => body),
        ),
      )

      expect(error).toMatchObject({ code: "size" })
      expect(String(error)).not.toContain(secret)
    })
  }

  test("cancels a streamed body as soon as it exceeds 64 KiB", async () => {
    let cancelled = false
    let count = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (count === 0) {
          count++
          controller.enqueue(new Uint8Array(limit))
          return
        }
        if (count === 1) {
          count++
          controller.enqueue(new Uint8Array(1))
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        if (!cancelled) controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const error = await thrown(() =>
      query(
        url,
        "secret-key",
        fetcher(async () => new Response(body)),
      ),
    )

    expect(error).toMatchObject({ code: "size" })
    expect(cancelled).toBe(true)
  })
})

describe("OpenCode Go usage decoding and normalization", () => {
  test("decodes the three usage entries and normalizes their exact windows", () => {
    const value = decode(
      payload({
        rolling: { status: "ok", percent: 17, resetsAt: "2026-08-12T05:00:00.000Z" },
        weekly: { status: "ok", percent: 7, resetsAt: "2026-08-19T00:00:00.000Z" },
        monthly: { status: "ok", percent: 3, resetsAt: "2026-09-01T00:00:00.000Z" },
      }),
    )
    const item = normalize(value, { label: "OpenCode Go account", fetchedAt })

    expect(item).toMatchObject({
      id: "opencode-go",
      providerID: "opencode-go",
      sourceKind: "direct",
      providerLabel: "OpenCode Go account",
      planLabel: "Subscription",
      sourceLabel: "API key",
      fetchState: "ready",
      planState: "active",
      routingState: "not_applicable",
      fetchedAt,
      managementUrl: "https://opencode.ai/console/go",
    })
    expect(item.windows).toEqual([
      {
        id: "opencode-go-rolling",
        resource: "subscription",
        unit: "percent",
        orientation: "used_percent",
        used: 17,
        remaining: 83,
        limit: 100,
        period: { unit: "hour", value: 5 },
        durationMs: 18_000_000,
        resetAt: "2026-08-12T05:00:00.000Z",
        state: "active",
      },
      {
        id: "opencode-go-weekly",
        resource: "subscription",
        unit: "percent",
        orientation: "used_percent",
        used: 7,
        remaining: 93,
        limit: 100,
        period: { unit: "week", value: 1 },
        durationMs: 604_800_000,
        resetAt: "2026-08-19T00:00:00.000Z",
        state: "active",
      },
      {
        id: "opencode-go-monthly",
        resource: "subscription",
        unit: "percent",
        orientation: "used_percent",
        used: 3,
        remaining: 97,
        limit: 100,
        period: { unit: "month", value: 1 },
        resetAt: "2026-09-01T00:00:00.000Z",
        state: "active",
      },
    ])
  })

  test("clamps used percentages and preserves a rate-limited reported percent", () => {
    const item = normalize(
      decode(
        payload({
          rolling: { percent: 150, status: "ok" },
          weekly: { percent: -5, status: "ok" },
          monthly: { percent: 17, status: " RATE-LIMITED " },
        }),
      ),
      { label: "OpenCode Go", fetchedAt },
    )

    expect(item.windows[0]).toMatchObject({ used: 100, remaining: 0, limit: 100, state: "exhausted" })
    expect(item.windows[1]).toMatchObject({ used: 0, remaining: 100, limit: 100, state: "active" })
    expect(item.windows[2]).toMatchObject({ used: 17, remaining: 83, limit: 100, state: "exhausted" })
  })

  test("includes a rate-limited status-only window without inventing numbers", () => {
    const item = normalize(decode(payload({ monthly: { status: "rate-limited" } })), {
      label: "OpenCode Go",
      fetchedAt,
    })

    expect(item.windows).toEqual([
      {
        id: "opencode-go-monthly",
        resource: "subscription",
        unit: "percent",
        orientation: "used_percent",
        period: { unit: "month", value: 1 },
        state: "exhausted",
      },
    ])
  })

  test("keeps partial usable windows, treats unknown status with a percent as active, and omits invalid resets", () => {
    const item = normalize(
      decode(
        payload({
          rolling: { status: "unknown", percent: 12, resetsAt: "not-a-date" },
          monthly: { status: "ok" },
        }),
      ),
      { label: "OpenCode Go", fetchedAt },
    )

    expect(item.windows).toHaveLength(1)
    expect(item.windows[0]).toMatchObject({ id: "opencode-go-rolling", used: 12, state: "active" })
    expect(item.windows[0]).not.toHaveProperty("resetAt")
  })

  test("omits resetAt for non-RFC3339 values", () => {
    const item = normalize(decode(payload({ monthly: { status: "ok", percent: 3, resetsAt: "0" } })), {
      label: "OpenCode Go",
      fetchedAt,
    })

    expect(item.windows[0]).not.toHaveProperty("resetAt")
  })

  test("rejects absent or unusable usage shapes", () => {
    for (const value of [
      undefined,
      null,
      {},
      { usage: null },
      { usage: [] },
      { usage: { rolling: [] } },
      { usage: { monthly: { percent: "17" } } },
      { usage: { monthly: { status: "ok" } } },
    ]) {
      expect(() => decode(value)).toThrow("OpenCode Go usage is unavailable.")
    }
  })

  test("normalization rejects a native value with no usable windows", () => {
    expect(() => normalize({} as Parameters<typeof normalize>[0], { label: "OpenCode Go", fetchedAt })).toThrow(
      "OpenCode Go usage is unavailable.",
    )
  })

  test("does not turn non-finite percentages into usage numbers", () => {
    expect(() =>
      normalize({ monthly: { percent: Number.NaN, status: "ok" } } as Parameters<typeof normalize>[0], {
        label: "OpenCode Go",
        fetchedAt,
      }),
    ).toThrow("OpenCode Go usage is unavailable.")

    const item = normalize(
      { monthly: { percent: Number.POSITIVE_INFINITY, status: "rate-limited" } } as Parameters<typeof normalize>[0],
      { label: "OpenCode Go", fetchedAt },
    )
    expect(item.windows[0]).toMatchObject({ state: "exhausted" })
    expect(item.windows[0]).not.toHaveProperty("used")
    expect(item.windows[0]).not.toHaveProperty("remaining")
    expect(item.windows[0]).not.toHaveProperty("limit")
  })
})

describe("OpenCode Go usage loading", () => {
  test("returns a ready snapshot on success", async () => {
    const item = await load(
      candidate,
      fetcher(async () =>
        response(
          payload({
            monthly: { percent: 3, status: "ok" },
          }),
        ),
      ),
    )

    expect(item).toMatchObject({ id: "opencode-go", fetchState: "ready", windows: [{ used: 3 }] })
  })

  test("returns non-retryable unavailable usage for auth failures", async () => {
    const item = await load(
      candidate,
      fetcher(async () => response("private auth response", 401)),
    )

    expect(item).toMatchObject({
      id: "opencode-go",
      providerID: "opencode-go",
      fetchState: "unavailable",
      planState: "unknown",
      windows: [],
      error: {
        code: "opencode_go_auth_unavailable",
        message: "This key cannot read OpenCode Go usage.",
        retryable: false,
      },
    })
    expect(JSON.stringify(item)).not.toContain("private auth response")
  })

  test("returns retryable unavailable usage for network failures without upstream text", async () => {
    const item = await load(
      candidate,
      fetcher(async () => {
        throw new Error("private network response")
      }),
    )

    expect(item).toMatchObject({
      fetchState: "unavailable",
      windows: [],
      error: { code: "opencode_go_usage_unavailable", message: "Usage unavailable.", retryable: true },
    })
    expect(JSON.stringify(item)).not.toContain("private network response")
  })
})
