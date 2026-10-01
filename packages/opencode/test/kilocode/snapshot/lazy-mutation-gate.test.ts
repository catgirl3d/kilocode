import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { KiloSnapshotGate } from "@/kilocode/snapshot/gate"
import { KiloSnapshotMutation } from "@/kilocode/snapshot/mutation"
import { testEffect } from "../../lib/effect"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
const makeGate = (
  input: Omit<KiloSnapshotGate.Input, "patch" | "persist"> & Partial<Pick<KiloSnapshotGate.Input, "patch" | "persist">>,
) =>
  KiloSnapshotGate.make({
    ...input,
    patch: input.patch ?? (() => Effect.succeed({ hash: "patch", files: [] })),
    persist: input.persist ?? (() => Effect.void),
  })
const runtime = testEffect(Layer.empty)
const it = (name: string, body: () => void | Promise<void>) =>
  runtime.live(
    name,
    Effect.promise(() => Promise.resolve(body())),
  )

describe("lazy snapshot mutation gate", () => {
  it("does not track until a mutation is requested", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => `snap_${++tracks}`),
      updatePart: (part) => Effect.succeed(part),
    })

    expect(tracks).toBe(0)
    expect(await run(gate.ensure())).toBe("snap_1")
    expect(tracks).toBe(1)
  })

  it("keeps a read-only tool step at zero snapshot tracks", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => (++tracks, "unexpected")),
      updatePart: (part) => Effect.succeed(part),
    })

    if (KiloSnapshotMutation.mayMutate({ tool: "read", args: {} })) await run(gate.ensure())
    expect(tracks).toBe(0)
  })

  it("updates a step part captured after the tool race", async () => {
    const parts: Array<{ snapshot?: string }> = []
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.succeed("baseline"),
      updatePart: (part) => Effect.sync(() => (parts.push(part), part)),
    })

    await run(gate.ensure())
    await run(
      gate.startStep({
        id: "part_test" as never,
        messageID: "msg_test" as never,
        sessionID: "ses_test" as never,
        type: "step-start",
        time: { start: 1 },
      }),
    )
    expect(parts.at(-1)?.snapshot).toBe("baseline")
  })

  it("updates the persisted step part when the baseline follows step-start", async () => {
    const parts: Array<{ id: unknown; snapshot?: string }> = []
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.succeed("baseline"),
      updatePart: (part) => Effect.sync(() => (parts.push(part), part)),
    })
    const step = {
      id: "part_test" as never,
      messageID: "msg_test" as never,
      sessionID: "ses_test" as never,
      type: "step-start" as const,
      time: { start: 1 },
    }

    await run(gate.startStep(step))
    expect(parts).toHaveLength(1)
    expect(parts[0]?.snapshot).toBeUndefined()
    await run(gate.ensure())
    expect(parts).toHaveLength(2)
    expect(parts[1]).toEqual({ ...step, snapshot: "baseline" })
  })

  it("does not capture at SDK step boundaries", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => (++tracks === 1 ? "baseline" : "finish")),
      updatePart: (part) => Effect.succeed(part),
    })

    const result = await run(
      Effect.gen(function* () {
        yield* gate.finishStep()
        const baseline = yield* gate.ensure()
        yield* gate.finishStep()
        yield* gate.finishStep()
        return baseline
      }),
    )
    expect(result).toBe("baseline")
    expect(tracks).toBe(1)
  })

  it("waits for an in-flight baseline before finishing a step", async () => {
    const result = await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<string>()
        const gate = makeGate({
          sessionID: "ses_test" as never,
          messageID: "msg_test" as never,
          track: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              return yield* Deferred.await(release)
            }),
          updatePart: (part) => Effect.succeed(part),
        })

        yield* gate.startStep({
          id: "part_test" as never,
          messageID: "msg_test" as never,
          sessionID: "ses_test" as never,
          type: "step-start",
          time: { start: 1 },
        })
        const fiber = yield* Effect.forkChild(gate.ensure())
        yield* Deferred.await(started)
        const finished = yield* gate.finishStep().pipe(Effect.forkChild)
        yield* Deferred.succeed(release, "baseline")
        return { finished: yield* Fiber.join(finished), ensured: yield* Fiber.join(fiber) }
      }),
    )

    expect(result.finished).toBeUndefined()
    expect(result.ensured).toBe("baseline")
  })

  it("does not retry an unsuccessful baseline on another SDK step", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => (++tracks === 1 ? undefined : "baseline-2")),
      updatePart: (part) => Effect.succeed(part),
    })
    const step = (id: string) => ({
      id: id as never,
      messageID: "msg_test" as never,
      sessionID: "ses_test" as never,
      type: "step-start" as const,
      time: { start: 1 },
    })

    await run(gate.startStep(step("part-1")))
    expect(await run(gate.ensure())).toBeUndefined()
    expect(await run(gate.ensure())).toBeUndefined()
    await run(gate.finishStep())
    await run(gate.startStep(step("part-2")))
    expect(await run(gate.ensure())).toBeUndefined()
    expect(await run(gate.ensure())).toBeUndefined()
    expect(tracks).toBe(1)
  })

  it("retains one baseline across sequential mutating steps", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => `snapshot-${++tracks}`),
      updatePart: (part) => Effect.succeed(part),
    })
    const step = (id: string) => ({
      id: id as never,
      messageID: "msg_test" as never,
      sessionID: "ses_test" as never,
      type: "step-start" as const,
      time: { start: 1 },
    })

    await run(gate.startStep(step("part-1")))
    expect(await run(gate.ensure())).toBe("snapshot-1")
    await run(gate.finishStep())
    await run(gate.startStep(step("part-2")))
    expect(await run(gate.ensure())).toBe("snapshot-1")
    await run(gate.finishStep())
    expect(tracks).toBe(1)
  })

  it("shares one baseline across concurrent mutation requests", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.promise(async () => `snapshot-${++tracks}`),
      updatePart: (part) => Effect.succeed(part),
    })

    const [first, second] = await run(Effect.all([gate.ensure(), gate.ensure()], { concurrency: "unbounded" }))
    await run(gate.finishStep())

    expect(first).toBe("snapshot-1")
    expect(second).toBe("snapshot-1")
    expect(tracks).toBe(1)
  })

  it("keeps an unsuccessful baseline attempt sticky across SDK steps", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () =>
        Effect.sync(() => {
          tracks += 1
          return undefined
        }),
      updatePart: (part) => Effect.succeed(part),
    })
    const step = (id: string) => ({
      id: id as never,
      messageID: "msg_test" as never,
      sessionID: "ses_test" as never,
      type: "step-start" as const,
      time: { start: 1 },
    })

    await run(gate.startStep(step("part-1")))
    await run(gate.ensure())
    await run(gate.finishStep())
    await run(gate.startStep(step("part-2")))
    expect(await run(gate.ensure())).toBeUndefined()
    expect(tracks).toBe(1)
  })

  it("serializes response and settlement captures using the same baseline", async () => {
    const state = await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let tracks = 0
        let active = 0
        let max = 0
        const patches: Array<[string, string]> = []
        const stored: Array<{ snapshot: string; append: boolean }> = []
        const gate = makeGate({
          sessionID: "ses_test" as never,
          messageID: "msg_test" as never,
          track: () =>
            Effect.gen(function* () {
              tracks++
              active++
              max = Math.max(max, active)
              if (tracks === 2) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
              active--
              return tracks === 1 ? "baseline" : `after-${tracks}`
            }),
          updatePart: (part) => Effect.succeed(part),
          patch: (before, after) =>
            Effect.sync(() => {
              patches.push([before, after])
              return { hash: after, files: [] }
            }),
          persist: (input) =>
            Effect.sync(() => {
              stored.push({ snapshot: input.snapshot, append: input.append })
            }),
        })
        yield* gate.ensure()
        const response = yield* Effect.forkChild(gate.checkpoint())
        yield* Deferred.await(entered)
        const settled = yield* Effect.forkChild(gate.checkpoint({ append: true }))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(response)
        yield* Fiber.join(settled)
        return { tracks, max, patches, stored }
      }),
    )

    expect(state.tracks).toBe(3)
    expect(state.max).toBe(1)
    expect(state.patches).toEqual([
      ["baseline", "after-2"],
      ["baseline", "after-3"],
    ])
    expect(state.stored).toEqual([
      { snapshot: "after-2", append: false },
      { snapshot: "after-3", append: true },
    ])
  })

  it("retries a response checkpoint after persist fails", async () => {
    let tracks = 0
    let persists = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      baseline: "baseline",
      track: () => Effect.sync(() => `after-${++tracks}`),
      updatePart: (part) => Effect.succeed(part),
      persist: () =>
        Effect.gen(function* () {
          persists++
          if (persists === 1) return yield* Effect.die(new Error("persist failed"))
        }),
    })
    await run(gate.ensure())

    const first = await run(Effect.exit(gate.checkpoint()))
    expect(Exit.isFailure(first)).toBe(true)
    await run(gate.checkpoint())

    expect(tracks).toBe(2)
    expect(persists).toBe(2)
  })

  it("releases a settled job observer so a later invocation can observe it", async () => {
    const state = await run(
      Effect.gen(function* () {
        const end: Array<Effect.Effect<void>> = []
        let starts = 0
        const gate = makeGate({
          sessionID: "ses_test" as never,
          messageID: "msg_test" as never,
          track: () => Effect.succeed("baseline"),
          updatePart: (part) => Effect.succeed(part),
        })
        const observe = gate.observe("job_test", (settle) =>
          Effect.sync(() => {
            starts++
            end.push(settle)
          }),
        )
        yield* Effect.all([observe, observe], { concurrency: "unbounded" })
        yield* end[0]!
        yield* gate.observe("job_test", (settle) =>
          Effect.sync(() => {
            starts++
            end.push(settle)
          }),
        )
        return starts
      }),
    )

    expect(state).toBe(2)
  })
  // Keep classifier cases in this serial suite because Effect's test runtime
  // owns shared fibers while the gate tests exercise concurrency.
  const check = (tool: string, args: Record<string, unknown> = {}, shell?: "read" | "unknown") =>
    KiloSnapshotMutation.mayMutate({ tool, args, shell })

  it("classifies explicit writes and read-only tools", () => {
    expect(check("edit")).toBe(true)
    expect(check("apply_patch")).toBe(true)
    expect(check("read")).toBe(false)
    expect(check("grep")).toBe(false)
    expect(check("codebase_search")).toBe(false)
    expect(check("kilo_local_recall")).toBe(false)
    expect(check("list_mcp_resources")).toBe(false)
    expect(check("list_mcp_resource_templates")).toBe(false)
    expect(check("read_mcp_resource")).toBe(false)
    expect(check("question")).toBe(false)
    expect(check("todowrite")).toBe(false)
  })

  it("fails closed for shell, plugin, and generic MCP tools", () => {
    expect(check("bash", { command: "git status" }, "read")).toBe(false)
    expect(check("bash", { command: "git diff" }, "read")).toBe(false)
    expect(check("bash", { command: "rg snapshot" }, "read")).toBe(false)
    expect(check("bash", { command: "echo x > file" }, "unknown")).toBe(true)
    expect(check("plugin_tool")).toBe(true)
    expect(check("mcp_server_custom_tool")).toBe(true)
  })

  it("treats shell-capable task and background actions as mutations", () => {
    expect(check("task", { background: false })).toBe(true)
    expect(check("task", { background: true })).toBe(true)
    expect(check("background_process", { action: "start" })).toBe(true)
    expect(check("background_process", { action: "restart" })).toBe(true)
    expect(check("background_process", { action: "list" })).toBe(false)
    expect(check("background_process", { action: "status" })).toBe(false)
    expect(check("background_process", { action: "logs" })).toBe(false)
    expect(check("background_process", { action: "stop" })).toBe(false)
    expect(check("background_process", { action: "unknown" })).toBe(true)
  })
})
