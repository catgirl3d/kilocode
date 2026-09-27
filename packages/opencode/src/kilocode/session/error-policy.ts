// fork_change - new file
import { isKiloError } from "@/kilocode/kilo-errors"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { MessageV2 } from "@/session/message-v2"
import { AuthError } from "@/session/message-error"
import { SessionNetwork } from "@/session/network"
import type { Err, Retryable } from "@/session/retry"
import { isRecord } from "@/util/record"

/**
 * The one place that says which model failures end a turn and which are waited out.
 *
 * A failed attempt flows through three layers:
 *   1. `decide` looks at the raw error and what the attempt already did (RULES below).
 *      `retry` goes on to the schedule, `resume` closes the step as a tool turn, everything
 *      else stops the schedule so SessionProcessor.halt / KiloSessionProcessor.recover own it.
 *   2. `SessionRetry.retryable` says which errors are transient (5xx, 429, network, message
 *      patterns). Its Kilo-specific part is `classify` here; the errors it calls `persistent`
 *      (sign-in required, quota, a bad request) are not transient, waiting will not fix them.
 *      The patterns and backoff constants stay in session/retry.ts because upstream owns them.
 *   3. `fallback` still retries everything `retryable` rejected, so an agent or sub-agent
 *      waits through quota, free-usage limits and unrecognised errors instead of dying, and the
 *      operator stops the run to give up. The exceptions are the HOPELESS table (errors only the
 *      operator or a code change can fix: they end the run as a red error) plus aborts,
 *      overflow and closed attempts. `fallback` is the single switch for what is waited on:
 *      `not-retried` and `tool-ran` follow it.
 *
 * consult_advisor passes no fallback on purpose. Its failure comes back to the agent as a tool
 * result, so a persistent advisor error (bad advisor model, quota) degrades that one call
 * instead of blocking the whole run; only transient errors are waited out there.
 *
 * Turn-level terminal errors that are enforced at their own sites are listed in TERMINAL.
 * Anything that ends a turn belongs in RULES or TERMINAL; the goal runner pauses on every one
 * of them (kilocode/session/goal/runner.ts).
 *
 * Regression map — symptom, where to look, what pins it:
 *   a retryable error ends the turn        RULES retry + fallback       error-policy.test.ts, session-processor-unbounded-retry.test.ts
 *   a failure after partial text/reasoning rewind before the retry      session-processor-incomplete-response-retry.test.ts
 *   a tool is repeated after a failure     RULES tool-ran -> resume     session-processor-incomplete-response-retry.test.ts
 *   an expired sign-in stops the run       classify expiredToken        error-policy.test.ts, session-processor-unbounded-retry.test.ts
 *   quota / sign-in / bad request cannot wait HOPELESS + fallback       error-policy.test.ts
 *   the wait before a retry is wrong       delay + policy set({ next }) test/session/retry.test.ts
 *   a new compact rule is ignored          halt reads the verdict       test/session/prompt.test.ts
 *   a TERMINAL symbol was renamed or moved TERMINAL registry            error-policy.test.ts
 */
export namespace KiloErrorPolicy {
  export const INCOMPLETE_RESPONSE_RETRIES = 2
  export const INCOMPLETE_RESPONSE_MESSAGE =
    "The provider repeatedly ended the response before returning usable output."

  /** A stream that ended without usable output; KiloSessionProcessor.recover owns its bounded retries. */
  export class IncompleteResponseError extends Error {
    constructor(readonly vercelID?: string) {
      super(INCOMPLETE_RESPONSE_MESSAGE)
      this.name = "IncompleteResponseError"
    }
  }

  /** True when an unknown finish carries nothing worth keeping, so the attempt is replayed. */
  export function replayable(input: {
    finish?: string
    text: boolean
    reasoning: boolean
    tool: boolean
    usage: boolean
  }) {
    if (input.finish !== undefined && input.finish !== "unknown") return false
    if (input.text || input.tool) return false
    // Reasoning without text or tools has no actionable output. Retry it through
    // the existing bounded recovery budget instead of silently settling unknown.
    // Keeping this decision here avoids the unbounded loop caused by continuing
    // every unknown finish at the prompt-loop boundary.
    if (input.reasoning) return true
    return !input.usage
  }

  /**
   * - `retry`: wait and request again; text and reasoning of the failed attempt are rewound first.
   * - `resume`: a tool already ran, so close the step as a tool turn and let the loop continue.
   * - `compact`: the conversation is too large; compaction handles it.
   * - `incomplete`: an empty response; the bounded recovery loop handles it.
   * - `stop`: nothing waits for it: the operator interrupted, or fallback() declines it.
   */
  export type Action = "retry" | "resume" | "compact" | "incomplete" | "stop"

  export type Facts = {
    raw: unknown
    error: Err
    attempt: { tool: boolean }
  }

  export type Verdict = {
    rule: string
    action: Action
    message?: string
  }

  type Rule = {
    id: string
    action: Action
    why: string
    match: (facts: Facts) => boolean
  }

  /** First match wins. The last rule matches everything. */
  export const RULES: readonly Rule[] = [
    {
      id: "preflight",
      action: "compact",
      why: "Internal signal that the prompt is over budget before any request; halt turns it into compaction.",
      match: (facts) => facts.raw instanceof KiloSessionOverflow.PreflightError,
    },
    {
      id: "incomplete-response",
      action: "incomplete",
      why: "The provider ended the stream with no usable output; recover() retries it within INCOMPLETE_RESPONSE_RETRIES.",
      match: (facts) => facts.raw instanceof IncompleteResponseError,
    },
    {
      id: "abort",
      action: "stop",
      why: "The operator interrupted the run.",
      match: (facts) => MessageV2.AbortedError.isInstance(facts.error),
    },
    {
      id: "context-overflow",
      action: "compact",
      why: "The provider rejected the context size; halt turns it into compaction.",
      match: (facts) => MessageV2.ContextOverflowError.isInstance(facts.error),
    },
    {
      id: "not-retried",
      action: "stop",
      why: "fallback() declines it (an attempt closed by blockRetry, or an error on the HOPELESS table), so nothing waits for it and a tool that ran is not resumed either.",
      match: (facts) => fallback(facts.error, facts.raw) === undefined,
    },
    {
      id: "tool-ran",
      action: "resume",
      why: "A tool call already ran in this attempt. Replaying it would repeat side effects, so keep its results and continue.",
      match: (facts) => facts.attempt.tool,
    },
    {
      id: "retry",
      action: "retry",
      why: "Everything else waits and retries with capped backoff until it recovers or the operator stops the run.",
      match: () => true,
    },
  ]

  export function decide(facts: Facts): Verdict {
    const rule = RULES.find((item) => item.match(facts))
    const action = rule?.action ?? "retry"
    return {
      rule: rule?.id ?? "retry",
      action,
      message: action === "retry" || action === "resume" ? fallback(facts.error, facts.raw)?.message : undefined,
    }
  }

  const BLOCKED = "blocked"

  /** Marks an error so neither `retryable` nor `fallback` will retry it. Only used as schedule input. */
  export function blockRetry(error: Err) {
    const message = MessageV2.APIError.isInstance(error) ? error.data.message : "Response interrupted after output"
    return new MessageV2.APIError({ message, isRetryable: false, metadata: { retry: BLOCKED } }).toObject()
  }

  const EXPIRED_TOKEN = /authentication token is expired/i
  /** A 401 that only a token refresh fixes; waited on instead of stopped. Shared by classify and HOPELESS. */
  const expiredToken = (error: Err) =>
    MessageV2.APIError.isInstance(error) &&
    (EXPIRED_TOKEN.test(error.data.message) || EXPIRED_TOKEN.test(error.data.responseBody ?? ""))

  /**
   * Kilo's share of SessionRetry.retryable for API errors. A Retryable is transient, `persistent`
   * means retryable() does not call it transient because waiting will not fix it (`fallback`
   * may still retry it), and undefined leaves the decision to upstream's rules.
   */
  export function classify(error: Err): "persistent" | Retryable | undefined {
    if (!MessageV2.APIError.isInstance(error)) return
    const status = error.data.statusCode
    const body = error.data.responseBody
    // Current Kilo errors require user action (login or sign-up).
    if (isKiloError(error)) return "persistent"
    // Not transient: the model stays capped and the retry loop holds its model, so switching
    // under a waiting run does not help. fallback still waits on it by policy; a quota reset
    // or the operator stopping and sending again is what clears it.
    if (body?.includes("FreeUsageLimitError")) return "persistent"
    // An expired sign-in resumes once the token is refreshed.
    if (status === 401 && expiredToken(error)) return { message: error.data.message }
    // Every other 401 stops the run even when the SDK marked it retryable: fallback's HOPELESS
    // table turns it into a red error instead of waiting for credentials that will not change.
    if (status === 401) return "persistent"
    if (error.data.isRetryable === false && (status === undefined || status < 500) && !body) return "persistent"
    return undefined
  }

  export type Hopeless = {
    id: string
    why: string
    match: (error: Err, raw?: unknown) => boolean
  }

  const status = (error: Err) => (MessageV2.APIError.isInstance(error) ? error.data.statusCode : undefined)
  const body = (error: Err) => (MessageV2.APIError.isInstance(error) ? (error.data.responseBody ?? "") : "")
  const PROGRAMMER = [TypeError, ReferenceError, RangeError, SyntaxError]

  /**
   * Errors that waiting cannot fix: they need the operator (sign in, key, model, request) or a
   * code change. They skip the wait and end the run as a red error. Only errors `retryable`
   * already rejected get here, so recognised network and rate-limit errors are never matched.
   * Not listed on purpose, so they wait: a bare 400 (gateways report overload that way), 402 and
   * quota errors (the operator tops up), free-usage limits and anything unrecognised.
   */
  export const HOPELESS: readonly Hopeless[] = [
    {
      id: "kilo-user-action",
      why: "Sign-in or sign-up required; the TUI and VS Code open their prompt from this error event.",
      match: (error) => isKiloError(error),
    },
    {
      id: "provider-auth",
      why: "A missing key or an expired or revoked sign-in is fixed by the operator, not by waiting.",
      match: (error) => AuthError.isInstance(error),
    },
    {
      id: "unauthorized",
      why: "401 that is not an expired token (those are waited on): the credentials are wrong.",
      match: (error) => status(error) === 401 && !expiredToken(error),
    },
    {
      id: "forbidden",
      why: "403: the key, region or account is not allowed.",
      match: (error) => status(error) === 403,
    },
    {
      id: "model-not-found",
      why: "The model or endpoint does not exist; the config will not change by itself.",
      match: (error) => status(error) === 404 || /model[_ -]?not[_ -]?found/i.test(body(error)),
    },
    {
      id: "invalid-request",
      why: "The provider names the request itself as invalid or unsupported, and the same request is rejected every time.",
      match: (error) =>
        (status(error) === 400 || status(error) === 422) &&
        /invalid_request_error|unsupported_[a-z_]+/i.test(body(error)),
    },
    {
      id: "programmer-error",
      why: "A TypeError, ReferenceError, RangeError or SyntaxError that is not a network failure is a bug; retrying only loops it.",
      match: (_, raw) => PROGRAMMER.some((kind) => raw instanceof kind) && !SessionNetwork.disconnected(raw),
    },
  ]

  /**
   * Retries what `retryable` rejected. Aborts, context overflow, attempts closed by blockRetry
   * and the HOPELESS errors stay terminal. `raw` is the error as thrown, for rules that need
   * its class.
   */
  export function fallback(error: Err, raw?: unknown): Retryable | undefined {
    if (MessageV2.AbortedError.isInstance(error)) return
    if (MessageV2.ContextOverflowError.isInstance(error)) return
    if (MessageV2.APIError.isInstance(error) && error.data.metadata?.retry === BLOCKED) return
    if (HOPELESS.some((item) => item.match(error, raw))) return
    const message = isRecord(error.data) ? error.data.message : undefined
    return { message: typeof message === "string" && message ? message : error.name }
  }

  /**
   * Turn-level failures that still end a run. `stoppedIn` is the file where the run is stopped
   * (relative to packages/opencode) and `symbol` is an identifier that must appear there; a test
   * checks both, so a rename or move shows up here. The error itself may be built elsewhere.
   */
  export const TERMINAL = [
    {
      id: "abort",
      stoppedIn: "src/session/processor.ts",
      symbol: "AbortError",
      why: "halt records AbortedError when the operator interrupts.",
    },
    {
      id: "operator-rejected",
      stoppedIn: "src/session/processor.ts",
      symbol: "Question.RejectedError",
      why: "A rejected permission, question or dismissed suggestion blocks the loop (failToolCall).",
    },
    {
      id: "malformed-tool-breaker",
      stoppedIn: "src/session/processor.ts",
      symbol: "malformedToolGuard.inspect",
      why: "Three consecutive invalid-argument tool calls abort the turn so a stuck model stops burning tokens. The guard lives in kilocode/session/processor.ts.",
    },
    {
      id: "incomplete-response-exhausted",
      stoppedIn: "src/kilocode/session/processor.ts",
      symbol: "INCOMPLETE_RESPONSE_RETRIES",
      why: "recover() fails with the empty-response error once the bounded retries are used up.",
    },
    {
      id: "content-filter",
      stoppedIn: "src/session/prompt.ts",
      symbol: "ContentFilterError",
      why: "The provider blocked the response, so the same request would be blocked again.",
    },
    {
      id: "provider-finish-error",
      stoppedIn: "src/session/prompt.ts",
      symbol: "providerFinishError",
      why: "The provider ended the response with finish reason error and no details. The error is built by KiloSessionProcessor.providerFinishError.",
    },
    {
      id: "structured-output-missing",
      stoppedIn: "src/session/prompt.ts",
      symbol: "StructuredOutputError",
      why: "The model finished without producing the requested structured output.",
    },
    {
      id: "compaction-exhausted",
      stoppedIn: "src/session/prompt.ts",
      symbol: "guardCompactionAttempt",
      why: "Repeated compaction attempts that do not fit the context end the turn. The guard lives in kilocode/session/prompt.ts.",
    },
  ] as const
}
