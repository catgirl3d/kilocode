import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { ConsultAdvisorTool, acquire, release } from "../../../src/kilocode/tool/consult-advisor"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { MessageID, SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { Truncate } from "../../../src/tool/truncate"
import { Tool } from "../../../src/tool/tool"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "../../lib/effect"

describe("consult advisor", () => {
  test("guards concurrent consultations per session and releases the guard", () => {
    expect(acquire("session")).toBe(true)
    expect(acquire("session")).toBe(false)
    release("session")
    expect(acquire("session")).toBe(true)
    release("session")
  })
})

const model = { providerID: "prov", id: "model", variants: { low: {}, high: {} } } as unknown as Provider.Model

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

function layer(
  variant: string,
  streams: LLM.StreamInput[],
  text = "guidance",
  error?: Error,
  events?: () => Stream.Stream<LLMEvent, unknown>,
) {
  const config = {
    experimental: { advisor_model: "prov/model", advisor_variant: variant },
  } as unknown as Config.Info
  return Layer.mergeAll(
    AppNodeBuilder.build(Truncate.node),
    Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
    Layer.mock(Config.Service, { get: () => Effect.succeed(config) }),
    Layer.mock(Provider.Service, { getModel: () => Effect.succeed(model) }),
    Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as unknown as Session.Info) }),
    Layer.mock(LLM.Service, {
      stream: (input: LLM.StreamInput) => {
        streams.push(input)
        if (error) return Stream.fail(error)
        if (events) return events()
        return Stream.make(
          LLMEvent.reasoningStart({ id: "reasoning" }),
          LLMEvent.reasoningDelta({ id: "reasoning", text: "thinking" }),
          LLMEvent.reasoningDelta({ id: "reasoning", text: "" }),
          LLMEvent.reasoningEnd({ id: "reasoning" }),
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text }),
          LLMEvent.textDelta({ id: "text", text: "" }),
          LLMEvent.textEnd({ id: "text" }),
        )
      },
    }),
  )
}

function context(
  sessionID: string,
  currentAssistant?: SessionV1.Assistant & { parts?: SessionV1.Part[] },
  metadata?: { title?: string; metadata?: Record<string, any> }[],
  signal?: AbortSignal,
  retrying?: Deferred.Deferred<void>,
): Tool.Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_advisor"),
    agent: "build",
    abort: signal ?? AbortSignal.any([]),
    extra: currentAssistant ? { currentAssistant } : undefined,
    messages: [],
    metadata: (input) =>
      Effect.sync(() => {
        metadata?.push(input)
        if (input.title === "Advisor retrying" && retrying) Deferred.doneUnsafe(retrying, Effect.void)
      }),
    ask: () => Effect.void,
  }
}

const blocked: LLM.StreamInput[] = []
const itBlocked = testEffect(layer("bogus", blocked))

const busyStreams: LLM.StreamInput[] = []
const busyState = {
  calls: 0,
  gate: undefined as Deferred.Deferred<void> | undefined,
  started: undefined as Deferred.Deferred<void> | undefined,
}
const itBusy = testEffect(
  layer("high", busyStreams, "guidance", undefined, () => {
    busyState.calls += 1
    if (busyState.calls === 1 && busyState.started) Deferred.doneUnsafe(busyState.started, Effect.void)
    if (busyState.calls !== 1) {
      return Stream.make(
        LLMEvent.textStart({ id: "text" }),
        LLMEvent.textDelta({ id: "text", text: "guidance" }),
        LLMEvent.textEnd({ id: "text" }),
      )
    }
    const gate = busyState.gate
    if (!gate) return Stream.fail(new Error("busy test gate was not initialized"))
    return Stream.unwrap(
      Deferred.await(gate).pipe(
        Effect.as(
          Stream.make(
            LLMEvent.textStart({ id: "text" }),
            LLMEvent.textDelta({ id: "text", text: "guidance" }),
            LLMEvent.textEnd({ id: "text" }),
          ),
        ),
      ),
    )
  }),
)

itBlocked.effect("reports an unavailable configured variant without contacting the LLM", () =>
  Effect.gen(function* () {
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_blocked", undefined, titles))

    expect(result.title).toBe("Advisor unavailable")
    expect(result.output).toContain("The configured advisor variant is unavailable: bogus")
    expect(result.output).toContain("Available variants: low, high")
    expect(blocked).toEqual([])
    expect(titles).toEqual([{ title: "Preparing advisor context" }])

    const retry = yield* tool.execute({ question: "retry" }, context("ses_blocked"))
    expect(retry.title).toBe("Advisor unavailable")
  }),
)

itBusy.effect("rejects overlapping consultations and releases the guard after completion", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    busyState.calls = 0
    busyState.gate = gate
    busyState.started = started
    busyStreams.length = 0

    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const first = yield* tool
      .execute({ question: "review" }, context("ses_busy", undefined, titles))
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)

    const blocked = yield* tool.execute({ question: "review again" }, context("ses_busy"))
    expect(blocked.title).toBe("Advisor busy")
    expect(busyStreams).toHaveLength(1)

    yield* Deferred.succeed(gate, undefined)
    expect((yield* Fiber.join(first)).title).toBe("Advisor completed")

    expect((yield* tool.execute({ question: "after completion" }, context("ses_busy"))).title).toBe("Advisor completed")
    expect(busyStreams).toHaveLength(2)
  }),
)

itBusy.effect("releases the guard after consultation cancellation", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const ctl = new AbortController()
    busyState.calls = 0
    busyState.gate = gate
    busyState.started = started
    busyStreams.length = 0

    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const first = yield* tool
      .execute({ question: "cancel" }, context("ses_abort", undefined, undefined, ctl.signal))
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)

    ctl.abort()
    const exit = yield* Fiber.await(first)
    expect(Exit.isFailure(exit)).toBe(true)
    expect((yield* tool.execute({ question: "after cancellation" }, context("ses_abort"))).title).toBe(
      "Advisor completed",
    )
    expect(busyStreams).toHaveLength(2)
  }),
)

const requested: LLM.StreamInput[] = []
const itStreams = testEffect(layer("high", requested))

itStreams.effect("streams one guidance consultation with the resolved variant", () =>
  Effect.gen(function* () {
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_stream", undefined, titles))

    expect(result.title).toBe("Advisor completed")
    expect(result.output).toBe("guidance")
    expect(titles).toEqual([
      { title: "Preparing advisor context" },
      { title: "Waiting for first response" },
      { title: "Advisor is reasoning" },
      { title: "Advisor is writing" },
      { title: "Advisor completed" },
    ])
    const content = requested[0]?.messages[0]?.content
    expect(content).toContain("Focus: general")
    expect(content).toContain("Question: review")
    expect(content).toContain("Recent conversation transcript:\n\n[no prior context]")
    expect(content).not.toContain("Proposal:")
    expect(content).not.toContain("Current assistant message (in progress):")
    expect(requested).toEqual([
      expect.objectContaining({
        sessionID: "ses_stream-advisor",
        parentSessionID: "ses_stream",
        toolChoice: "none",
        tools: {},
        agent: expect.objectContaining({ name: "advisor" }),
        user: expect.objectContaining({
          agent: "advisor",
          model: expect.objectContaining({ providerID: "prov", modelID: "model", variant: "high" }),
        }),
      }),
    ])
  }),
)

const failed: LLM.StreamInput[] = []
const itFailed = testEffect(layer("high", failed, "guidance", new Error("plain failure")))

itFailed.effect("reports a failed status when the advisor stream fails", () =>
  Effect.gen(function* () {
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_failed", undefined, titles))

    expect(result.title).toBe("Advisor failed")
    expect(result.output).toContain("Advisor consultation failed: plain failure")
    expect(titles).toEqual([
      { title: "Preparing advisor context" },
      { title: "Waiting for first response" },
      { title: "Advisor failed" },
    ])

    const retry = yield* tool.execute({ question: "retry" }, context("ses_failed"))
    expect(retry.title).toBe("Advisor failed")
    expect(failed).toHaveLength(2)
  }),
)

const rateLimit = new APICallError({
  message: "429 usage limit",
  url: "https://example.com",
  requestBodyValues: {},
  statusCode: 429,
  responseHeaders: { "retry-after-ms": "1" },
  isRetryable: true,
})
const retried: LLM.StreamInput[] = []
const itRetried = testEffect(
  layer("high", retried, "guidance", undefined, () => {
    if (retried.length <= 6) {
      return Stream.make(
        LLMEvent.textStart({ id: "text" }),
        LLMEvent.textDelta({ id: "text", text: "partial failed guidance" }),
      ).pipe(Stream.concat(Stream.fail(rateLimit)))
    }
    return Stream.make(
      LLMEvent.textStart({ id: "text" }),
      LLMEvent.textDelta({ id: "text", text: "guidance from the final attempt" }),
      LLMEvent.textEnd({ id: "text" }),
    )
  }),
)

itRetried.live("retries repeated rate limits with fresh streams and returns only final guidance", () =>
  Effect.gen(function* () {
    retried.length = 0
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_retry", undefined, titles))

    expect(retried).toHaveLength(7)
    expect(result.title).toBe("Advisor completed")
    expect(result.output).toBe("guidance from the final attempt")
    expect(result.output).not.toContain("Advisor consultation failed")
    expect(titles).toContainEqual({ title: "Advisor retrying" })
  }),
)

const network: LLM.StreamInput[] = []
const itNetwork = testEffect(
  layer("high", network, "guidance", undefined, () => {
    if (network.length === 1) return Stream.fail(new Error("fetch failed"))
    return Stream.make(
      LLMEvent.textStart({ id: "text" }),
      LLMEvent.textDelta({ id: "text", text: "guidance after network retry" }),
      LLMEvent.textEnd({ id: "text" }),
    )
  }),
)

itNetwork.effect("retries a transient network failure and returns guidance", () =>
  Effect.gen(function* () {
    network.length = 0
    const retrying = yield* Deferred.make<void>()
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const call = yield* tool
      .execute({ question: "review" }, context("ses_network_retry", undefined, undefined, undefined, retrying))
      .pipe(Effect.forkChild)

    const state = yield* Effect.raceFirst(
      Deferred.await(retrying).pipe(Effect.as("retrying" as const)),
      Fiber.await(call).pipe(Effect.as("finished" as const)),
    )
    expect(state).toBe("retrying")
    yield* Effect.yieldNow
    yield* TestClock.adjust("3 seconds")

    const result = yield* Fiber.join(call)
    expect(network).toHaveLength(2)
    expect(result.title).toBe("Advisor completed")
    expect(result.output).toBe("guidance after network retry")
  }),
)

const delayed = new APICallError({
  message: "429 usage limit",
  url: "https://example.com",
  requestBodyValues: {},
  statusCode: 429,
  responseHeaders: { "retry-after-ms": "60000" },
  isRetryable: true,
})
const waiting: LLM.StreamInput[] = []
const itWaiting = testEffect(layer("high", waiting, "guidance", undefined, () => Stream.fail(delayed)))

itWaiting.effect("interrupts during an advisor retry wait without another stream", () =>
  Effect.gen(function* () {
    const retrying = yield* Deferred.make<void>()
    const ctl = new AbortController()
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const call = yield* tool
      .execute({ question: "review" }, context("ses_retry_abort", undefined, titles, ctl.signal, retrying))
      .pipe(Effect.forkChild)

    const state = yield* Effect.raceFirst(
      Deferred.await(retrying).pipe(Effect.as("retrying" as const)),
      Fiber.await(call).pipe(Effect.as("finished" as const)),
    )
    expect(state).toBe("retrying")
    yield* Effect.yieldNow
    ctl.abort()

    const exit = yield* Fiber.await(call)
    if (Exit.isSuccess(exit)) throw new Error("expected advisor cancellation")
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(waiting).toHaveLength(1)
    expect(titles).toContainEqual({ title: "Advisor retrying" })
    expect(titles.at(-1)).toEqual({ title: "Advisor cancelled" })
  }),
)

const badRequest = new APICallError({
  message: "Bad request",
  url: "https://example.com",
  requestBodyValues: {},
  statusCode: 400,
  isRetryable: false,
})
const terminal: LLM.StreamInput[] = []
const itTerminal = testEffect(layer("high", terminal, "guidance", badRequest))

itTerminal.effect("does not retry a non-retryable advisor API error", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_terminal"))

    expect(terminal).toHaveLength(1)
    expect(result.title).toBe("Advisor failed")
    expect(result.output).toContain("Advisor consultation failed: Bad request")
  }),
)

const large = "x".repeat(50 * 1024 + 1)
const itLarge = testEffect(layer("high", [], large))

itLarge.effect("preserves guidance larger than the generic truncation limit", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_large"))

    expect(result.output).toBe(large)
    expect(result.metadata.truncated).toBe(false)
  }),
)

itBlocked.effect("reports preparation before an unavailable consultation", () =>
  Effect.gen(function* () {
    const titles: { title?: string; metadata?: Record<string, any> }[] = []
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_blocked_status", undefined, titles))

    expect(result.title).toBe("Advisor unavailable")
    expect(titles).toEqual([{ title: "Preparing advisor context" }])
  }),
)

itStreams.effect("includes a proposal verbatim in the advisor message", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const proposal = "Step 1: inspect the boundary.\nStep 2: preserve the existing contract."
    yield* tool.execute({ question: "review the plan", proposal }, context("ses_proposal"))

    const content = requested.at(-1)?.messages[0]?.content
    expect(content).toContain(`Proposal:\n\n${proposal}`)
  }),
)

itStreams.effect("includes text parts from the in-progress assistant", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const current = {
      id: MessageID.make("msg_current"),
      parts: [
        { id: "part_text", type: "text", text: "The assistant is still writing this plan." },
        { id: "part_reasoning", type: "reasoning", text: "private reasoning" },
        { id: "part_tool", type: "tool", tool: "read", state: { status: "pending", input: {}, raw: "" } },
      ],
    } as unknown as SessionV1.Assistant & { parts: SessionV1.Part[] }
    yield* tool.execute({ question: "review current work" }, context("ses_current", current))

    const content = requested.at(-1)?.messages[0]?.content
    expect(content).toContain("Current assistant message (in progress):\n\nThe assistant is still writing this plan.")
    expect(content).not.toContain("private reasoning")
    expect(content).not.toContain('"part_tool"')
  }),
)
