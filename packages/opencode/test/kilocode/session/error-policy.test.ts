import { describe, expect, test } from "bun:test"
import { LoadAPIKeyError } from "ai"
import { Effect, Exit, Schedule } from "effect"
import fs from "fs"
import path from "path"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { KiloErrorPolicy } from "../../../src/kilocode/session/error-policy"
import { KiloSessionOverflow } from "../../../src/kilocode/session/overflow"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionRetry } from "../../../src/session/retry"

const providerID = ProviderV2.ID.make("test")
const parse = (raw: unknown) => MessageV2.fromError(raw, { providerID })
// Mirrors KiloSessionProcessor.parseError: already-serialized errors pass through untouched.
const named = (raw: unknown) =>
  MessageV2.ContextOverflowError.isInstance(raw) || MessageV2.APIError.isInstance(raw) ? raw : parse(raw)
const api = (input: ConstructorParameters<typeof MessageV2.APIError>[0]) => new MessageV2.APIError(input).toObject()
const idle = { tool: false }
const ran = { tool: true }

// Errors that end the run as a red error: one fixture per HOPELESS rule.
const hopeless: Record<string, unknown> = {
  "kilo-user-action": api({
    message: "Sign up",
    statusCode: 429,
    isRetryable: false,
    responseBody: JSON.stringify({ code: "PROMOTION_MODEL_LIMIT_REACHED" }),
  }),
  "provider-auth": new LoadAPIKeyError({ message: "API key is missing" }),
  unauthorized: api({ message: "Invalid API key", statusCode: 401, isRetryable: false }),
  forbidden: api({ message: "Forbidden", statusCode: 403, isRetryable: false }),
  "model-not-found": api({ message: "No such model", statusCode: 404, isRetryable: false }),
  "invalid-request": api({
    message: "Bad parameter",
    statusCode: 400,
    isRetryable: false,
    responseBody: JSON.stringify({ error: { type: "invalid_request_error", message: "Unsupported parameter" } }),
  }),
  "programmer-error": new TypeError("x is not a function"),
}

// Errors that keep waiting for the operator or the provider.
const waits: Record<string, unknown> = {
  "a free usage limit": api({
    message: "Limit reached",
    statusCode: 429,
    isRetryable: false,
    responseBody: '{"type":"FreeUsageLimitError"}',
  }),
  "a bare 400": api({ message: "Bad request", statusCode: 400, isRetryable: false }),
  "an out-of-credit error": api({
    message: "Insufficient credits",
    statusCode: 402,
    isRetryable: false,
    responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
  }),
  "an unrecognised error": new Error("something unexpected broke"),
  "a fetch failure": new TypeError("fetch failed"),
  "a TypeError caused by a reset connection": Object.assign(new TypeError("boom"), {
    cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  }),
}

describe("KiloErrorPolicy.decide", () => {
  const overflow = new MessageV2.ContextOverflowError({ message: "Too long" }).toObject()
  const reset = api({ message: "Connection reset by server", isRetryable: true })
  const preflight = new KiloSessionOverflow.PreflightError()
  const incomplete = new KiloErrorPolicy.IncompleteResponseError()
  const abort = new DOMException("Aborted", "AbortError")
  const boom = new Error("something unexpected broke")
  const closed = KiloErrorPolicy.blockRetry(reset)

  // One row per rule, plus the precedence cases that make the order matter.
  const cases = [
    { name: "preflight signal", raw: preflight, attempt: idle, rule: "preflight", action: "compact" },
    { name: "preflight beats a ran tool", raw: preflight, attempt: ran, rule: "preflight", action: "compact" },
    { name: "empty response", raw: incomplete, attempt: idle, rule: "incomplete-response", action: "incomplete" },
    {
      name: "empty response beats a ran tool",
      raw: incomplete,
      attempt: ran,
      rule: "incomplete-response",
      action: "incomplete",
    },
    { name: "operator abort", raw: abort, attempt: idle, rule: "abort", action: "stop" },
    { name: "abort beats a ran tool", raw: abort, attempt: ran, rule: "abort", action: "stop" },
    { name: "context overflow", raw: overflow, attempt: idle, rule: "context-overflow", action: "compact" },
    { name: "overflow beats a ran tool", raw: overflow, attempt: ran, rule: "context-overflow", action: "compact" },
    { name: "an attempt closed by blockRetry", raw: closed, attempt: idle, rule: "not-retried", action: "stop" },
    {
      name: "a closed attempt is not resumed after a tool",
      raw: closed,
      attempt: ran,
      rule: "not-retried",
      action: "stop",
    },
    { name: "a hopeless error", raw: hopeless.forbidden, attempt: idle, rule: "not-retried", action: "stop" },
    {
      name: "a hopeless error is not resumed after a tool",
      raw: hopeless.forbidden,
      attempt: ran,
      rule: "not-retried",
      action: "stop",
    },
    { name: "a programmer error", raw: hopeless["programmer-error"], attempt: idle, rule: "not-retried", action: "stop" },
    { name: "failure after a tool ran", raw: reset, attempt: ran, rule: "tool-ran", action: "resume" },
    {
      name: "a waited-on quota error after a tool ran is resumed",
      raw: waits["a free usage limit"],
      attempt: ran,
      rule: "tool-ran",
      action: "resume",
    },
    { name: "failure before any output", raw: reset, attempt: idle, rule: "retry", action: "retry" },
    { name: "unclassified failure", raw: boom, attempt: idle, rule: "retry", action: "retry" },
  ] as const

  for (const item of cases)
    test(item.name, () => {
      const verdict = KiloErrorPolicy.decide({ raw: item.raw, error: named(item.raw), attempt: item.attempt })
      expect({ rule: verdict.rule, action: verdict.action }).toEqual({ rule: item.rule, action: item.action })
    })

  test("a retry and a resume carry the message to show", () => {
    expect(KiloErrorPolicy.decide({ raw: reset, error: reset, attempt: idle }).message).toBe(
      "Connection reset by server",
    )
    expect(KiloErrorPolicy.decide({ raw: reset, error: reset, attempt: ran }).message).toBe(
      "Connection reset by server",
    )
    expect(KiloErrorPolicy.decide({ raw: abort, error: parse(abort), attempt: idle }).message).toBeUndefined()
  })

  test("an expired sign-in is waited on from decide instead of stopped", () => {
    const raw = api({ message: "Your authentication token is expired", statusCode: 401, isRetryable: false })
    expect(KiloErrorPolicy.decide({ raw, error: named(raw), attempt: idle }).action).toBe("retry")
    expect(KiloErrorPolicy.decide({ raw, error: named(raw), attempt: ran }).action).toBe("resume")
  })

  test("every rule is exercised and ids are unique", () => {
    const ids = KiloErrorPolicy.RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set<string>(cases.map((item) => item.rule))).toEqual(new Set<string>(ids))
  })

  test("the last rule matches everything", () => {
    const last = KiloErrorPolicy.RULES.at(-1)
    expect(last?.match({ raw: undefined, error: parse(boom), attempt: idle })).toBe(true)
  })
})

describe("KiloErrorPolicy.fallback", () => {
  test("retries a client error that retryable() treats as terminal", () => {
    const error = api({ message: "Bad request", statusCode: 400, isRetryable: false })
    expect(SessionRetry.retryable(error)).toBeUndefined()
    expect(KiloErrorPolicy.fallback(error)).toEqual({ message: "Bad request" })
  })

  test("retries a free usage limit that retryable() treats as terminal", () => {
    const error = waits["a free usage limit"] as ReturnType<typeof api>
    expect(SessionRetry.retryable(error)).toBeUndefined()
    expect(KiloErrorPolicy.fallback(error)).toEqual({ message: "Limit reached" })
  })

  test("retries an unclassified error with its message", () => {
    const error = parse(new Error("something unexpected broke"))
    expect(SessionRetry.retryable(error)).toBeUndefined()
    expect(KiloErrorPolicy.fallback(error)).toEqual({ message: "something unexpected broke" })
  })

  test("keeps an operator abort terminal", () => {
    expect(KiloErrorPolicy.fallback(parse(new DOMException("Aborted", "AbortError")))).toBeUndefined()
  })

  test("keeps context overflow terminal so compaction can handle it", () => {
    expect(
      KiloErrorPolicy.fallback(new MessageV2.ContextOverflowError({ message: "Too long" }).toObject()),
    ).toBeUndefined()
  })

  test("keeps an attempt closed by blockRetry terminal", () => {
    const error = api({ message: "Connection reset by server", isRetryable: true })
    expect(KiloErrorPolicy.fallback(error)).toEqual({ message: "Connection reset by server" })
    expect(KiloErrorPolicy.fallback(KiloErrorPolicy.blockRetry(error))).toBeUndefined()
    expect(SessionRetry.retryable(KiloErrorPolicy.blockRetry(error))).toBeUndefined()
  })
})

describe("KiloErrorPolicy.classify", () => {
  test("a Kilo user-action error is persistent", () => {
    const error = api({
      message: "Sign in",
      statusCode: 401,
      isRetryable: false,
      responseBody: JSON.stringify({ error: { code: "PAID_MODEL_AUTH_REQUIRED" } }),
    })
    expect(KiloErrorPolicy.classify(error)).toBe("persistent")
  })

  test("a free usage limit is persistent even when marked retryable", () => {
    const error = api({
      message: "Limit reached",
      statusCode: 429,
      isRetryable: true,
      responseBody: '{"type":"FreeUsageLimitError"}',
    })
    expect(KiloErrorPolicy.classify(error)).toBe("persistent")
  })

  test("an expired sign-in 401 retries until the token is refreshed", () => {
    const error = api({ message: "Your authentication token is expired", statusCode: 401, isRetryable: false })
    expect(KiloErrorPolicy.classify(error)).toEqual({ message: "Your authentication token is expired" })
  })

  test("a 401 is persistent even when the SDK marks it retryable", () => {
    const error = api({ message: "Invalid API key", statusCode: 401, isRetryable: true })
    expect(KiloErrorPolicy.classify(error)).toBe("persistent")
  })

  test("a non-retryable bodyless error is persistent", () => {
    expect(KiloErrorPolicy.classify(api({ message: "Nope", statusCode: 400, isRetryable: false }))).toBe("persistent")
  })

  test("a statusless non-retryable error is persistent", () => {
    expect(KiloErrorPolicy.classify(api({ message: "Nope", isRetryable: false }))).toBe("persistent")
  })

  test("a non-retryable error with a body is left to upstream", () => {
    expect(
      KiloErrorPolicy.classify(api({ message: "Nope", statusCode: 400, isRetryable: false, responseBody: "{}" })),
    ).toBeUndefined()
  })

  test("everything else is left to the upstream rules", () => {
    expect(KiloErrorPolicy.classify(api({ message: "Overloaded", statusCode: 503, isRetryable: true }))).toBeUndefined()
    expect(KiloErrorPolicy.classify(parse(new Error("boom")))).toBeUndefined()
  })
})

// The pieces above are right in isolation; what runs in production is retryable() ?? fallback()
// inside SessionRetry.policy, so pin the composition: who keeps waiting and who is done.
describe("SessionRetry.policy with the policy module", () => {
  const keeps = (input: unknown, always?: typeof KiloErrorPolicy.fallback) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: "test",
            parse: named,
            set: () => Effect.void,
            ...(always ? { always } : {}),
          }),
        )
        return !Exit.isFailure(yield* Effect.exit(step(input)))
      }),
    )

  for (const [id, error] of Object.entries(hopeless)) {
    test(`${id} ends the run as a red error in the agent loop`, async () => {
      expect(await keeps(error, KiloErrorPolicy.fallback)).toBe(false)
    })

    test(`${id} ends a call that has no fallback`, async () => {
      expect(await keeps(error)).toBe(false)
    })
  }

  for (const [name, error] of Object.entries(waits))
    test(`${name} keeps waiting in the agent loop`, async () => {
      expect(await keeps(error, KiloErrorPolicy.fallback)).toBe(true)
    })

  test("persistent errors that are not hopeless end a call that has no fallback", async () => {
    for (const name of ["a free usage limit", "a bare 400", "an out-of-credit error"])
      expect(await keeps(waits[name])).toBe(false)
  })

  test("a transient error is retried with or without the fallback", async () => {
    const error = api({ message: "Overloaded", statusCode: 503, isRetryable: true })
    expect(await keeps(error)).toBe(true)
    expect(await keeps(error, KiloErrorPolicy.fallback)).toBe(true)
  })

  test("an expired sign-in is waited on, not hopeless", async () => {
    const error = api({ message: "Your authentication token is expired", statusCode: 401, isRetryable: false })
    expect(await keeps(error, KiloErrorPolicy.fallback)).toBe(true)
  })

  test("a retryable 401 ends the run instead of waiting", async () => {
    const error = api({ message: "Invalid API key", statusCode: 401, isRetryable: true })
    expect(await keeps(error, KiloErrorPolicy.fallback)).toBe(false)
  })

  test("aborts, context overflow and blocked attempts end the loop even with the fallback", async () => {
    const reset = api({ message: "Connection reset by server", isRetryable: true })
    expect(await keeps(new DOMException("Aborted", "AbortError"), KiloErrorPolicy.fallback)).toBe(false)
    expect(
      await keeps(new MessageV2.ContextOverflowError({ message: "Too long" }).toObject(), KiloErrorPolicy.fallback),
    ).toBe(false)
    expect(await keeps(KiloErrorPolicy.blockRetry(reset), KiloErrorPolicy.fallback)).toBe(false)
  })
})

describe("KiloErrorPolicy.HOPELESS", () => {
  test("ids are unique and every rule has a fixture", () => {
    const ids = KiloErrorPolicy.HOPELESS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set<string>(Object.keys(hopeless))).toEqual(new Set<string>(ids))
  })

  for (const item of KiloErrorPolicy.HOPELESS)
    test(`${item.id} matches its fixture and is declined by fallback`, () => {
      const raw = hopeless[item.id]
      const error = named(raw)
      expect(item.match(error, raw)).toBe(true)
      expect(KiloErrorPolicy.fallback(error, raw)).toBeUndefined()
    })

  const programmer = KiloErrorPolicy.HOPELESS.find((item) => item.id === "programmer-error")

  test("a programmer error that is really a dropped connection is not hopeless", () => {
    const raw = waits["a TypeError caused by a reset connection"]
    expect(programmer?.match(named(raw), raw)).toBe(false)
  })

  test("a plain Error with the same message is not a programmer error", () => {
    const raw = new Error("x is not a function")
    expect(programmer?.match(named(raw), raw)).toBe(false)
  })

  test("an expired sign-in is not hopeless and fallback still waits on it", () => {
    const raw = api({ message: "Your authentication token is expired", statusCode: 401, isRetryable: false })
    const unauthorized = KiloErrorPolicy.HOPELESS.find((item) => item.id === "unauthorized")
    expect(unauthorized?.match(named(raw), raw)).toBe(false)
    expect(KiloErrorPolicy.fallback(named(raw), raw)).toEqual({ message: "Your authentication token is expired" })
  })

  test("422 and unsupported_* bodies are hopeless invalid requests", () => {
    const invalid = KiloErrorPolicy.HOPELESS.find((item) => item.id === "invalid-request")
    for (const raw of [
      api({
        message: "Unprocessable",
        statusCode: 422,
        isRetryable: false,
        responseBody: '{"error":{"type":"invalid_request_error"}}',
      }),
      api({
        message: "Bad parameter",
        statusCode: 400,
        isRetryable: false,
        responseBody: '{"error":{"type":"unsupported_value"}}',
      }),
    ]) {
      expect(invalid?.match(named(raw), raw)).toBe(true)
      expect(KiloErrorPolicy.fallback(named(raw), raw)).toBeUndefined()
    }
  })

  test("a model-not-found body alone is hopeless", () => {
    const rule = KiloErrorPolicy.HOPELESS.find((item) => item.id === "model-not-found")
    const raw = api({
      message: "Unknown",
      statusCode: 400,
      isRetryable: false,
      responseBody: '{"error":{"code":"model_not_found"}}',
    })
    expect(rule?.match(named(raw), raw)).toBe(true)
  })

  test("every programmer error class is hopeless, not just TypeError", () => {
    const rule = KiloErrorPolicy.HOPELESS.find((item) => item.id === "programmer-error")
    for (const raw of [new ReferenceError("x"), new RangeError("y"), new SyntaxError("z")]) {
      expect(rule?.match(named(raw), raw)).toBe(true)
    }
  })

  test("both Kilo user-action codes are hopeless", () => {
    const rule = KiloErrorPolicy.HOPELESS.find((item) => item.id === "kilo-user-action")
    const raw = api({
      message: "Sign in required",
      statusCode: 401,
      isRetryable: false,
      responseBody: JSON.stringify({ error: { code: "PAID_MODEL_AUTH_REQUIRED" } }),
    })
    expect(rule?.match(named(raw), raw)).toBe(true)
    expect(KiloErrorPolicy.fallback(named(raw), raw)).toBeUndefined()
  })

  test("a rate limit, a bare 400, a quota error and an unknown error match nothing", () => {
    const limited = api({ message: "Too many requests", statusCode: 429, isRetryable: true })
    for (const raw of [limited, waits["an unrecognised error"], waits["a bare 400"], waits["an out-of-credit error"]])
      expect(KiloErrorPolicy.HOPELESS.filter((item) => item.match(named(raw), raw)).map((item) => item.id)).toEqual([])
  })
})

describe("KiloErrorPolicy.TERMINAL", () => {
  const root = path.resolve(import.meta.dir, "../../..")

  test("ids are unique", () => {
    const ids = KiloErrorPolicy.TERMINAL.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const item of KiloErrorPolicy.TERMINAL)
    test(`${item.id} is still stopped in ${item.stoppedIn}`, () => {
      const file = path.join(root, item.stoppedIn)
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.readFileSync(file, "utf-8")).toContain(item.symbol)
    })
})
