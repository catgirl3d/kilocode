import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { InstanceState } from "../../../src/effect/instance-state"
import { ConsultAdvisorTool, acquire, release } from "../../../src/kilocode/tool/consult-advisor"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { MessageID, SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { Truncate } from "../../../src/tool/truncate"
import { Tool } from "../../../src/tool/tool"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../../fixture/fixture"
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
  ask?: Tool.Context["ask"],
  extra?: Tool.Context["extra"],
): Tool.Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_advisor"),
    agent: "build",
    abort: signal ?? AbortSignal.any([]),
    extra: extra ?? (currentAssistant ? { currentAssistant } : undefined),
    messages: [],
    metadata: (input) =>
      Effect.sync(() => {
        metadata?.push(input)
        if (input.title === "Advisor retrying" && retrying) Deferred.doneUnsafe(retrying, Effect.void)
      }),
    ask: ask ?? (() => Effect.void),
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

const fileRequested: LLM.StreamInput[] = []
const itFiles = testEffect(
  Layer.mergeAll(
    layer("high", fileRequested),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

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

const fileRetried: LLM.StreamInput[] = []
const itFileRetried = testEffect(
  Layer.mergeAll(
    layer("high", fileRetried, "guidance", undefined, () => {
      if (fileRetried.length === 1) return Stream.fail(rateLimit)
      return Stream.make(
        LLMEvent.textStart({ id: "text" }),
        LLMEvent.textDelta({ id: "text", text: "guidance after file retry" }),
        LLMEvent.textEnd({ id: "text" }),
      )
    }),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

itFileRetried.live("retries the prepared advisor body without rereading files or permissions", () =>
  Effect.gen(function* () {
    fileRetried.length = 0
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "retry.txt")
    yield* Effect.promise(() => writeFile(file, "retry body", "utf8"))
    let reads = 0
    const retrying = yield* Deferred.make<void>()
    const ask: Tool.Context["ask"] = (input) =>
      Effect.sync(() => {
        if (input.permission === "read") reads++
      })
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      Effect.gen(function* () {
        const call = yield* tool
          .execute(
            { materials: "retry material", files: [{ path: "retry.txt", start: 1, end: 1 }] },
            context("ses_file_retry", undefined, undefined, undefined, retrying, ask),
          )
          .pipe(Effect.forkChild)
        const state = yield* Effect.raceFirst(
          Deferred.await(retrying).pipe(Effect.as("retrying" as const)),
          Fiber.await(call).pipe(Effect.as("finished" as const)),
        )
        expect(state).toBe("retrying")
        yield* Effect.promise(() => writeFile(file, "changed body", "utf8"))
        return yield* Fiber.join(call)
      }),
    )

    expect(result.title).toBe("Advisor completed")
    expect(fileRetried).toHaveLength(2)
    expect(reads).toBe(1)
    expect(fileRetried[0]?.messages[0]?.content).toBe(fileRetried[1]?.messages[0]?.content)
    expect(fileRetried[1]?.messages[0]?.content).toContain("retry body")
    expect(fileRetried[1]?.messages[0]?.content).not.toContain("changed body")
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

itFiles.live("includes selected file lines and materials in the advisor payload without tools", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "sample.txt")
    yield* Effect.promise(() => writeFile(file, "skip\r\nselected one\r\nselected two\nlast", "utf8"))
    const canonical = yield* Effect.promise(() => realpath(file))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute(
        {
          question: "review",
          materials: "diff material",
          files: [{ path: "sample.txt", start: 2, end: 3 }],
        },
        context("ses_files"),
      ),
    )

    expect(result.title).toBe("Advisor completed")
    expect(fileRequested).toHaveLength(1)
    const content = fileRequested[0]?.messages[0]?.content
    expect(content).toContain("Materials:\n\ndiff material")
    expect(content).toContain(`File: ${canonical}`)
    expect(content).toContain("Lines: 2-3")
    expect(content).toContain("2: selected one")
    expect(content).toContain("3: selected two")
    expect(content).not.toContain("1: skip")
    expect(content).not.toContain("4: last")
    expect(fileRequested[0]).toEqual(expect.objectContaining({ tools: {}, toolChoice: "none" }))
  }),
)

itStreams.effect("rejects invalid file ranges before file access or an advisor call", () =>
  Effect.gen(function* () {
    requested.length = 0
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const cases = [
      { files: [{ path: "sample.txt", start: 1 }] },
      { files: [{ path: "sample.txt", end: 1 }] },
      { files: [{ path: "sample.txt", start: 2, end: 1 }] },
      { files: [{ path: "sample.txt", start: 1.5, end: 2 }] },
      { files: [{ path: "sample.txt", start: 0, end: 1 }] },
      { files: [{ path: "sample.txt", start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 1 }] },
      { files: [{ path: "", start: 1, end: 1 }] },
    ]

    for (const input of cases) {
      // @ts-expect-error Malformed table inputs intentionally exercise runtime schema validation.
      const exit = yield* tool.execute(input, context("ses_invalid_ranges")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) continue
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Tool.InvalidArgumentsError)
    }
    expect(requested).toEqual([])
  }),
)

itStreams.effect("enforces the shared materials budget without clipping or contacting the advisor", () =>
  Effect.gen(function* () {
    requested.length = 0
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const prefix = "Supplied materials and file excerpts:\n\nMaterials:\n\n"
    const exact = "x".repeat(100_000 - prefix.length)
    const success = yield* tool.execute({ materials: exact }, context("ses_material_limit_exact"))
    expect(success.title).toBe("Advisor completed")
    expect(requested.at(-1)?.messages[0]?.content).toContain(exact)

    const overflow = yield* tool.execute({ materials: `${exact}x` }, context("ses_material_limit_overflow"))
    expect(overflow.title).toBe("Advisor failed")
    expect(overflow.output).toContain("100000-character limit")
    expect(requested).toHaveLength(1)
  }),
)

itFiles.live("returns preparation errors without partial attachments and releases the busy guard", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "short.txt"), "one\ntwo", "utf8"))
    yield* Effect.promise(() => mkdir(path.join(dir, "folder")))
    yield* Effect.promise(() => writeFile(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3])))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const deny: Tool.Context["ask"] = () => Effect.die(new Error("read permission denied"))
    const cases: {
      path: string
      end?: number
      ask?: Tool.Context["ask"]
      detail?: string
      files?: { path: string; start: number; end: number }[]
    }[] = [
      { path: "missing.txt" },
      { path: "folder" },
      { path: "binary.bin" },
      { path: "short.txt", end: 3, detail: "out of range" },
      { path: "short.txt", ask: deny },
      {
        path: "short.txt",
        detail: "File not found",
        files: [
          { path: "short.txt", start: 1, end: 1 },
          { path: "missing-after.txt", start: 1, end: 1 },
        ],
      },
    ]

    for (const item of cases) {
      const result = yield* provideInstance(dir)(
        tool.execute(
          { files: item.files ?? [{ path: item.path, start: 1, end: item.end ?? 1 }] },
          context("ses_prepare_fail", undefined, undefined, undefined, undefined, item.ask),
        ),
      )
      expect(result.title).toBe("Advisor failed")
      expect(result.output).toContain("Advisor context preparation failed")
      if (item.detail) expect(result.output).toContain(item.detail)
    }

    expect(fileRequested).toEqual([])
    const valid = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "short.txt", start: 2, end: 2 }] }, context("ses_prepare_fail")),
    )
    expect(valid.title).toBe("Advisor completed")
    expect(fileRequested).toHaveLength(1)
  }),
)

itFiles.live("rejects a binary file whose printable prefix hides null bytes", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    const prefix = Buffer.from("printable line\n".repeat(600), "utf8")
    yield* Effect.promise(() =>
      writeFile(path.join(dir, "sneaky.bin"), Buffer.concat([prefix, Buffer.from([0, 1, 2, 3])])),
    )
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "sneaky.bin", start: 1, end: 601 }] }, context("ses_binary_prefix")),
    )
    expect(result.title).toBe("Advisor failed")
    expect(result.output).toContain("Cannot read binary file")
    expect(fileRequested).toEqual([])

    const before = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "sneaky.bin", start: 1, end: 2 }] }, context("ses_binary_after_range")),
    )
    expect(before.title).toBe("Advisor completed")
    expect(fileRequested).toHaveLength(1)
    expect(fileRequested[0]?.messages[0]?.content).toContain("2: printable line")
  }),
)

itFiles.live("rejects large non-UTF-8 files before buffering them", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "legacy-big.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 0xff)))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "legacy-big.txt", start: 1, end: 1 }] }, context("ses_decode_limit")),
    )
    expect(result.title).toBe("Advisor failed")
    expect(result.output).toContain("4194304-byte limit")
    expect(fileRequested).toEqual([])
  }),
)

itFiles.live("stops scanning past the file scan limit", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      writeFile(path.join(dir, "deep.txt"), `${"a".repeat(4 * 1024 * 1024 + 1)}\nb\nc\n`, "utf8"),
    )
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "deep.txt", start: 2, end: 3 }] }, context("ses_scan_limit")),
    )
    expect(result.title).toBe("Advisor failed")
    expect(result.output).toContain("scan limit")
    expect(fileRequested).toEqual([])
  }),
)

itFiles.live("reads a range that ends before the scan limit inside the crossing chunk", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    // Two-byte characters shift character offsets off the 64 KiB read boundaries, so the read that crosses the
    // scan limit also contains the requested line.
    const prefix = "é".repeat(1000)
    yield* Effect.promise(() =>
      writeFile(
        path.join(dir, "edge.txt"),
        `${prefix}${"a".repeat(4 * 1024 * 1024 - 1010)}\nok\n${"b".repeat(100)}`,
        "utf8",
      ),
    )
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "edge.txt", start: 2, end: 2 }] }, context("ses_scan_edge")),
    )
    expect(result.title).toBe("Advisor completed")
    expect(fileRequested[0]?.messages[0]?.content).toContain("2: ok")
  }),
)

itFiles.live("authorizes missing files through the canonical parent before failing", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    const outer = yield* tmpdirScoped()
    const missing = path.join(outer, "missing.txt")
    const asks: { permission: string; patterns: readonly string[] }[] = []
    const ask =
      (deny: string): Tool.Context["ask"] =>
      (input) => {
        asks.push({ permission: input.permission, patterns: input.patterns })
        if (input.permission === deny) return Effect.die(new Error(`${deny} denied`))
        return Effect.void
      }
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)

    const externalDenied = yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: missing, start: 1, end: 1 }] },
        context("ses_missing_external_denied", undefined, undefined, undefined, undefined, ask("external_directory")),
      ),
    )
    expect(externalDenied.title).toBe("Advisor failed")
    expect(asks.map((item) => item.permission)).toEqual(["external_directory"])
    expect(fileRequested).toEqual([])

    asks.length = 0
    const readDenied = yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: missing, start: 1, end: 1 }] },
        context("ses_missing_read_denied", undefined, undefined, undefined, undefined, ask("read")),
      ),
    )
    expect(readDenied.title).toBe("Advisor failed")
    expect(asks.map((item) => item.permission)).toEqual(["external_directory", "read"])
    expect(fileRequested).toEqual([])
  }),
)

itFiles.live("authorizes directories before reporting them as irregular files", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    const outer = yield* tmpdirScoped()
    const folder = path.join(outer, "folder")
    yield* Effect.promise(() => mkdir(folder))
    const asks: string[] = []
    const ask =
      (deny?: string): Tool.Context["ask"] =>
      (input) => {
        asks.push(input.permission)
        if (input.permission === deny) return Effect.die(new Error(`${deny} denied`))
        return Effect.void
      }
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)

    const externalDenied = yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: folder, start: 1, end: 1 }] },
        context("ses_folder_external_denied", undefined, undefined, undefined, undefined, ask("external_directory")),
      ),
    )
    expect(externalDenied.title).toBe("Advisor failed")
    expect(externalDenied.output).not.toContain("Not a regular file")
    expect(asks).toEqual(["external_directory"])

    asks.length = 0
    const allowed = yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: folder, start: 1, end: 1 }] },
        context("ses_folder_allowed", undefined, undefined, undefined, undefined, ask()),
      ),
    )
    expect(allowed.title).toBe("Advisor failed")
    expect(allowed.output).toContain("Not a regular file")
    expect(asks).toEqual(["external_directory", "read"])
    expect(fileRequested).toEqual([])
  }),
)

itFiles.live("propagates permission rejections instead of reporting an advisor failure", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "guarded.txt"), "guarded", "utf8"))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const errors = [
      new PermissionV1.RejectedError(),
      new PermissionV1.CorrectedError({ feedback: "use the diff instead" }),
      new PermissionV1.DeniedError({ ruleset: [] }),
    ]

    for (const err of errors) {
      const exit = yield* provideInstance(dir)(
        tool
          .execute(
            { files: [{ path: "guarded.txt", start: 1, end: 1 }] },
            context("ses_permission_rejected", undefined, undefined, undefined, undefined, () => Effect.die(err)),
          )
          .pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) continue
      expect(Cause.squash(exit.cause)).toBe(err)
    }
    expect(fileRequested).toEqual([])

    const valid = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "guarded.txt", start: 1, end: 1 }] }, context("ses_permission_rejected")),
    )
    expect(valid.title).toBe("Advisor completed")
  }),
)

itFiles.live("preserves line selection for LF, CRLF, and a final line without newline", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const cases = [
      { name: "lf.txt", text: "first\nsecond\nthird", start: 1, end: 3, lines: ["1: first", "2: second", "3: third"] },
      { name: "crlf.txt", text: "first\r\nsecond\r\nthird", start: 2, end: 3, lines: ["2: second", "3: third"] },
      { name: "last.txt", text: "first\nlast", start: 2, end: 2, lines: ["2: last"] },
    ]
    for (const item of cases) {
      fileRequested.length = 0
      yield* Effect.promise(() => writeFile(path.join(dir, item.name), item.text, "utf8"))
      const tool = yield* Tool.init(yield* ConsultAdvisorTool)
      const result = yield* provideInstance(dir)(
        tool.execute(
          { files: [{ path: item.name, start: item.start, end: item.end }] },
          context(`ses_eol_${item.name}`),
        ),
      )
      expect(result.title).toBe("Advisor completed")
      const content = fileRequested[0]?.messages[0]?.content ?? ""
      for (const line of item.lines) expect(content).toContain(line)
    }

    fileRequested.length = 0
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("first\nsecond", "utf16le")])
    yield* Effect.promise(() => writeFile(path.join(dir, "utf16.txt"), utf16))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "utf16.txt", start: 2, end: 2 }] }, context("ses_eol_utf16")),
    )
    expect(result.title).toBe("Advisor completed")
    expect(fileRequested[0]?.messages[0]?.content).toContain("2: second")
  }),
)

itFiles.live("does not duplicate a partial excerpt before UTF-8 fallback", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "partial-fallback.txt")
    const bytes = Buffer.concat([
      Buffer.from("marker\n"),
      Buffer.from("a".repeat(70_000)),
      Buffer.from([0xff]),
      Buffer.from("\nsuffix"),
    ])
    yield* Effect.promise(() => writeFile(file, bytes))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "partial-fallback.txt", start: 1, end: 3 }] }, context("ses_partial_fallback")),
    )

    expect(result.title).toBe("Advisor completed")
    const content = fileRequested[0]?.messages[0]?.content
    if (typeof content !== "string") throw new Error("expected text advisor content")
    const line = content.split("\n").find((item) => item.startsWith("2: "))
    expect(content.match(/1: marker/g)).toHaveLength(1)
    expect(line).toHaveLength(70_004)
    expect(content.match(/3: suffix/g)).toHaveLength(1)
  }),
)

itFiles.live("rejects a long selected line and combined attachments at the shared budget", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "long.txt"), "x".repeat(110_000), "utf8"))
    yield* Effect.promise(() => writeFile(path.join(dir, "small.txt"), "kept", "utf8"))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)

    const long = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "long.txt", start: 1, end: 1 }] }, context("ses_long_line")),
    )
    expect(long.title).toBe("Advisor failed")
    expect(long.output).toContain("100000-character limit")
    expect(fileRequested).toEqual([])

    const combined = yield* provideInstance(dir)(
      tool.execute(
        { materials: "x".repeat(99_900), files: [{ path: "small.txt", start: 1, end: 1 }] },
        context("ses_combined_budget"),
      ),
    )
    expect(combined.title).toBe("Advisor failed")
    expect(combined.output).toContain("100000-character limit")
    expect(fileRequested).toEqual([])
  }),
)

itFiles.live("uses canonical paths and keeps external-directory bypass separate from read permission", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const outer = yield* tmpdirScoped()
    const inside = path.join(dir, "inside.txt")
    const outside = path.join(outer, "outside.txt")
    yield* Effect.promise(() => writeFile(inside, "inside", "utf8"))
    yield* Effect.promise(() => writeFile(outside, "outside", "utf8"))
    const asks: { permission: string; patterns: readonly string[] }[] = []
    const instance = yield* provideInstance(dir)(InstanceState.context)
    const ask: Tool.Context["ask"] = (input) =>
      Effect.sync(() => asks.push({ permission: input.permission, patterns: input.patterns }))
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)

    yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: "inside.txt", start: 1, end: 1 }] },
        context("ses_paths", undefined, undefined, undefined, undefined, ask),
      ),
    )
    expect(asks.map((item) => item.permission)).toEqual(["read"])

    asks.length = 0
    yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: outside, start: 1, end: 1 }] },
        context("ses_paths_external", undefined, undefined, undefined, undefined, ask),
      ),
    )
    expect(asks.map((item) => item.permission)).toEqual(["external_directory", "read"])

    asks.length = 0
    yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: outside, start: 1, end: 1 }] },
        context("ses_paths_reference", undefined, undefined, undefined, undefined, ask, { referenceRoot: outer }),
      ),
    )
    expect(asks.map((item) => item.permission)).toEqual(["read"])

    const link = path.join(dir, "link.txt")
    const linked = yield* Effect.tryPromise({
      try: () => symlink(inside, link).then(() => true),
      catch: () => false,
    })
    if (!linked) return
    asks.length = 0
    yield* provideInstance(dir)(
      tool.execute(
        { files: [{ path: "link.txt", start: 1, end: 1 }] },
        context("ses_paths_link", undefined, undefined, undefined, undefined, ask),
      ),
    )
    expect(asks.map((item) => item.permission)).toEqual(["read"])
    expect(asks[0]?.patterns).toContain(path.relative(instance.worktree, inside))
  }),
)

itFiles.live("cancels while waiting for read permission and reuses the guard afterward", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "wait.txt"), "wait", "utf8"))
    const entered = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const ctl = new AbortController()
    const ask: Tool.Context["ask"] = (input) => {
      if (input.permission !== "read") return Effect.void
      Deferred.doneUnsafe(entered, Effect.void)
      return Deferred.await(gate)
    }
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const call = yield* tool
          .execute(
            { files: [{ path: "wait.txt", start: 1, end: 1 }] },
            context("ses_cancel_permission", undefined, undefined, ctl.signal, undefined, ask),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Effect.yieldNow
        ctl.abort()
        const exit = yield* Fiber.await(call)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }),
    )
    expect(fileRequested).toEqual([])

    const valid = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "wait.txt", start: 1, end: 1 }] }, context("ses_cancel_permission")),
    )
    expect(valid.title).toBe("Advisor completed")
    expect(fileRequested).toHaveLength(1)
  }),
)

itFiles.live("cancels after read permission before file access without an advisor error", () =>
  Effect.gen(function* () {
    fileRequested.length = 0
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => writeFile(path.join(dir, "read.txt"), "read", "utf8"))
    const ctl = new AbortController()
    const ask: Tool.Context["ask"] = (input) =>
      input.permission === "read" ? Effect.sync(() => ctl.abort()) : Effect.void
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const exit = yield* provideInstance(dir)(
      tool
        .execute(
          { files: [{ path: "read.txt", start: 1, end: 1 }] },
          context("ses_cancel_read", undefined, undefined, ctl.signal, undefined, ask),
        )
        .pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(fileRequested).toEqual([])

    const valid = yield* provideInstance(dir)(
      tool.execute({ files: [{ path: "read.txt", start: 1, end: 1 }] }, context("ses_cancel_read")),
    )
    expect(valid.title).toBe("Advisor completed")
  }),
)
