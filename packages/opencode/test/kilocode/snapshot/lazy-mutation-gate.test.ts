import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { KiloSnapshotGate } from "@/kilocode/snapshot/gate"
import { KiloSnapshotMutation } from "@/kilocode/snapshot/mutation"
import { testEffect } from "../../lib/effect"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
const makeGate = (input: Omit<KiloSnapshotGate.Input, "scope">) => KiloSnapshotGate.make(input)
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

  it("only performs terminal tracking for a step with a baseline", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.sync(() => (++tracks === 1 ? "baseline" : "finish")),
      updatePart: (part) => Effect.succeed(part),
    })

    const result = await run(
      Effect.gen(function* () {
        const empty = yield* gate.finishStep()
        const baseline = yield* gate.ensure()
        const finish = yield* gate.finishStep()
        return { empty, baseline, finish }
      }),
    )
    expect(result.empty.finish).toBeUndefined()
    expect(result.baseline).toBe("baseline")
    expect(result.finish.finish).toBe("finish")
    expect(tracks).toBe(2)
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

    expect(result.finished.baseline).toBe("baseline")
    expect(result.ensured).toBe("baseline")
  })

  it("retries an unsuccessful baseline only after a real step reset", async () => {
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
    expect(await run(gate.ensure())).toBe("baseline-2")
    expect(await run(gate.ensure())).toBe("baseline-2")
    expect(tracks).toBe(2)
  })

  it("resets the complete baseline and terminal lifecycle between sequential mutating steps", async () => {
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
    expect(await run(gate.finishStep())).toEqual({ baseline: "snapshot-1", finish: "snapshot-2" })
    await run(gate.startStep(step("part-2")))
    expect(await run(gate.ensure())).toBe("snapshot-3")
    expect(await run(gate.finishStep())).toEqual({ baseline: "snapshot-3", finish: "snapshot-4" })
    expect(tracks).toBe(4)
  })

  it("shares concurrent ensure and performs exactly one terminal track", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () => Effect.promise(async () => `snapshot-${++tracks}`),
      updatePart: (part) => Effect.succeed(part),
    })

    const [first, second] = await run(Effect.all([gate.ensure(), gate.ensure()], { concurrency: "unbounded" }))
    const finish = await run(gate.finishStep())

    expect(first).toBe("snapshot-1")
    expect(second).toBe("snapshot-1")
    expect(finish).toEqual({ baseline: "snapshot-1", finish: "snapshot-2" })
    expect(tracks).toBe(2)
  })

  it("resets after a terminal track failure and allows the next step to retry", async () => {
    let tracks = 0
    const gate = makeGate({
      sessionID: "ses_test" as never,
      messageID: "msg_test" as never,
      track: () =>
        Effect.sync(() => {
          tracks += 1
          if (tracks === 2) return undefined
          return `snapshot-${tracks}`
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
    expect(await run(gate.finishStep())).toEqual({ baseline: "snapshot-1", finish: undefined })
    await run(gate.startStep(step("part-2")))
    expect(await run(gate.ensure())).toBe("snapshot-3")
    expect(tracks).toBe(3)
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
