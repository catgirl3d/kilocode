// kilocode_change - new file
//
// Unit tests for KiloSnapshotTrack.wrap — the slow-repo guard that sits
// on top of Snapshot.track(). These tests inject fake hooks so we don't
// touch the real Question module or write to the filesystem.

import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Deferred, Duration, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID, type MessageID, type SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { KiloSnapshotTrack } from "../../src/kilocode/snapshot/track"
import { KiloPartLifecycle } from "../../src/kilocode/session/part-lifecycle"
import { AppRuntime } from "../../src/effect/app-runtime"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Session } from "../../src/session/session"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, it } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const SESSION = "ses_test" as SessionID
const MESSAGE = "msg_test" as MessageID

// Build a fast inner snapshot that resolves immediately with a hash.
const fastInner = (hash = "deadbeef") => Effect.succeed<string | undefined>(hash)

// Build a slow inner snapshot that resolves after `ms` milliseconds.
const slowInner = (ms: number, hash = "slowhash") =>
  Effect.promise(() => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(hash), ms)))

// Build an inner snapshot that never completes unless interrupted.
const hangInner = () => Effect.promise(() => new Promise<string | undefined>(() => {}))

// Build an inner snapshot that fails with a typed Effect error. The double
// cast mirrors how the real `Snapshot.track` Effect is shaped: callers see
// `Effect.Effect<string | undefined>` (error channel `never`), but failures
// can still flow through because the production code path uses `Effect.catch`
// to absorb them. Centralizing the cast here keeps per-test code readable.
const failingInner = (err: Error) =>
  Effect.fail(err as unknown as never) as unknown as Effect.Effect<string | undefined>

type Event = { kind: "start"; text: string } | { kind: "update"; text: string } | { kind: "end" }

interface Calls {
  ask: number
  persist: number
  progress: Event[]
}

const makeHooks = (
  answer: KiloSnapshotTrack.Answer | Promise<KiloSnapshotTrack.Answer>,
): { hooks: KiloSnapshotTrack.Hooks; calls: Calls } => {
  const calls: Calls = { ask: 0, persist: 0, progress: [] }
  const hooks: KiloSnapshotTrack.Hooks = {
    async ask() {
      calls.ask += 1
      return answer
    },
    async persistDisable() {
      calls.persist += 1
    },
    async startProgress(input) {
      calls.progress.push({ kind: "start", text: input.text })
    },
    async updateProgress(input) {
      calls.progress.push({ kind: "update", text: input.text })
    },
    async endProgress() {
      calls.progress.push({ kind: "end" })
    },
  }
  return { hooks, calls }
}

describe("KiloSnapshotTrack.protect", () => {
  it.effect("returns at the availability deadline without disabling snapshots", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const started = yield* Deferred.make<void>()
      const fallback = { hash: "base", files: [] as string[] }
      let finalized = false
      const inner = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true
          }),
        ),
      )
      const fiber = yield* KiloSnapshotTrack.protect({
        inner,
        state,
        fallback,
        operation: "patch",
        timeoutMs: 100,
      }).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust(100)

      expect(yield* Fiber.join(fiber)).toEqual(fallback)
      expect(finalized).toBe(true)
      expect(state.disabledForSession).toBe(false)
    }),
  )

  it.effect("allows a later operation after a deadline", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const started = yield* Deferred.make<void>()
      let calls = 0
      const first = yield* KiloSnapshotTrack.protect({
        inner: Effect.sync(() => {
          calls += 1
        }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
        state,
        fallback: undefined,
        operation: "track",
        timeoutMs: 100,
      }).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* TestClock.adjust(100)
      expect(yield* Fiber.join(first)).toBeUndefined()
      expect(state.disabledForSession).toBe(false)

      const second = yield* KiloSnapshotTrack.protect({
        inner: Effect.sync(() => {
          calls += 1
          return "retry"
        }),
        state,
        fallback: undefined,
        operation: "track",
      })
      expect(second).toBe("retry")
      expect(calls).toBe(2)
    }),
  )

  it.effect("does not spend the availability budget while its prompt is open", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const attempt = KiloSnapshotTrack.makeOperation()
      const asked = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<KiloSnapshotTrack.Answer>()
      const hash = yield* Deferred.make<string | undefined>()
      const { hooks: base } = makeHooks(answer.promise)
      const hooks: KiloSnapshotTrack.Hooks = {
        ...base,
        async ask() {
          asked.resolve()
          return answer.promise
        },
      }

      const fiber = yield* KiloSnapshotTrack.protect({
        inner: KiloSnapshotTrack.wrap({
          inner: Deferred.await(hash),
          state,
          attempt,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 10,
          progressDelayMs: 0,
        }),
        state,
        attempt,
        fallback: undefined,
        operation: "track",
        timeoutMs: 100,
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(10)
      yield* Effect.promise(() => asked.promise)
      yield* TestClock.adjust(100)

      expect(state.disabledForSession).toBe(false)
      answer.resolve("continue")
      yield* Deferred.succeed(hash, "late-hash")
      expect(yield* Fiber.join(fiber)).toBe("late-hash")
    }),
  )

  it.effect("resumes with the remaining active budget after the prompt", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const attempt = KiloSnapshotTrack.makeOperation()
      const asked = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<KiloSnapshotTrack.Answer>()
      const hash = yield* Deferred.make<string | undefined>()
      const done = yield* Deferred.make<string | undefined>()
      const { hooks: base } = makeHooks(answer.promise)
      const hooks: KiloSnapshotTrack.Hooks = {
        ...base,
        async ask() {
          asked.resolve()
          return answer.promise
        },
      }

      const fiber = yield* KiloSnapshotTrack.protect({
        inner: KiloSnapshotTrack.wrap({
          inner: Deferred.await(hash),
          state,
          attempt,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 10,
          progressDelayMs: 0,
        }),
        state,
        attempt,
        fallback: undefined,
        operation: "track",
        timeoutMs: 100,
      }).pipe(
        Effect.flatMap((value) => Deferred.succeed(done, value)),
        Effect.forkChild,
      )

      yield* TestClock.adjust(10)
      yield* Effect.promise(() => asked.promise)
      yield* TestClock.adjust(50)
      answer.resolve("continue")
      yield* Effect.yieldNow

      yield* TestClock.adjust(89)
      expect(yield* Deferred.isDone(done)).toBe(false)
      yield* TestClock.adjust(1)
      expect(yield* Deferred.isDone(done)).toBe(true)
      expect(yield* Deferred.await(done)).toBeUndefined()
      expect(yield* Fiber.join(fiber)).toBe(true)
    }),
  )

  it.effect("pauses only the operation that owns the prompt", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const firstAttempt = KiloSnapshotTrack.makeOperation()
      const secondAttempt = KiloSnapshotTrack.makeOperation()
      const asked = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<KiloSnapshotTrack.Answer>()
      const hash = yield* Deferred.make<string | undefined>()
      const secondDone = yield* Deferred.make<string>()
      const { hooks: base } = makeHooks(answer.promise)
      const hooks: KiloSnapshotTrack.Hooks = {
        ...base,
        async ask() {
          asked.resolve()
          return answer.promise
        },
      }

      const first = yield* KiloSnapshotTrack.protect({
        inner: KiloSnapshotTrack.wrap({
          inner: Deferred.await(hash),
          state,
          attempt: firstAttempt,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 10,
          progressDelayMs: 0,
        }),
        state,
        attempt: firstAttempt,
        fallback: undefined,
        operation: "track",
        timeoutMs: 100,
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(10)
      yield* Effect.promise(() => asked.promise)

      const second = yield* KiloSnapshotTrack.protect({
        inner: Effect.never,
        state,
        attempt: secondAttempt,
        fallback: "second-fallback",
        operation: "patch",
        timeoutMs: 100,
      }).pipe(
        Effect.flatMap((value) => Deferred.succeed(secondDone, value)),
        Effect.forkChild,
      )

      yield* TestClock.adjust(100)
      expect(yield* Deferred.isDone(secondDone)).toBe(true)
      expect(yield* Fiber.join(second)).toBe(true)
      expect(yield* Deferred.await(secondDone)).toBe("second-fallback")

      answer.resolve("continue")
      yield* Deferred.succeed(hash, "first-hash")
      expect(yield* Fiber.join(first)).toBe("first-hash")
    }),
  )

  it.effect("does not disable snapshots when the caller is interrupted", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const started = yield* Deferred.make<void>()
      const inner = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      })
      const fiber = yield* KiloSnapshotTrack.protect({
        inner,
        state,
        fallback: undefined,
        operation: "track",
        timeoutMs: 100,
      }).pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(state.disabledForSession).toBe(false)
    }),
  )

  it.effect("dismissal skips only the current slow call and preserves later availability", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const asked = yield* Deferred.make<void>()
      const firstCancelled = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const secondCancelled = yield* Deferred.make<void>()
      let askCount = 0
      const hooks: KiloSnapshotTrack.Hooks = {
        ...makeHooks("dismissed").hooks,
        async ask() {
          askCount += 1
          Deferred.doneUnsafe(asked, Effect.succeed(undefined))
          return "dismissed"
        },
      }
      const firstInner = Effect.never.pipe(Effect.ensuring(Deferred.succeed(firstCancelled, undefined)))
      const secondInner = Effect.succeed(undefined).pipe(
        Effect.andThen(Deferred.succeed(secondStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(secondCancelled, undefined)),
      )

      const first = yield* KiloSnapshotTrack.wrap({
        inner: firstInner,
        state,
        attempt: KiloSnapshotTrack.makeOperation(),
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 0,
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(10)
      yield* Deferred.await(asked)
      expect(yield* Fiber.join(first)).toBeUndefined()
      yield* Deferred.await(firstCancelled)

      const second = yield* KiloSnapshotTrack.wrap({
        inner: secondInner,
        state,
        attempt: KiloSnapshotTrack.makeOperation(),
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 0,
      }).pipe(Effect.forkChild)

      yield* Deferred.await(secondStarted)
      yield* TestClock.adjust(10)
      expect(yield* Fiber.join(second)).toBeUndefined()
      yield* Deferred.await(secondCancelled)

      expect(askCount).toBe(1)
      expect(state.disabledForSession).toBe(false)
    }),
  )

  it.effect("disables snapshots after a real protect failure and skips later inner work", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const fallback = { hash: "fallback", files: [] as string[] }
      let started = 0
      const first = yield* KiloSnapshotTrack.protect({
        inner: Effect.sync(() => {
          started += 1
        }).pipe(Effect.andThen(failingInner(new Error("snapshot failure"))), Effect.as(fallback)),
        state,
        fallback,
        operation: "track",
      })

      expect(first).toEqual(fallback)
      expect(started).toBe(1)
      expect(state.disabledForSession).toBe(true)

      const second = yield* KiloSnapshotTrack.protect({
        inner: Effect.sync(() => {
          started += 1
          return "should-not-start"
        }).pipe(Effect.as(fallback)),
        state,
        fallback,
        operation: "patch",
      })

      expect(second).toEqual(fallback)
      expect(started).toBe(1)
    }),
  )

  it.effect("parent interruption aborts the prompt, cleans its owner, and preserves later availability", () =>
    Effect.gen(function* () {
      const state = KiloSnapshotTrack.makeState()
      const asked = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const hooks: KiloSnapshotTrack.Hooks = {
        ...makeHooks("dismissed").hooks,
        async ask(_input, signal) {
          Deferred.doneUnsafe(asked, Effect.succeed(undefined))
          return new Promise<KiloSnapshotTrack.Answer>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                Deferred.doneUnsafe(aborted, Effect.succeed(undefined))
                resolve("dismissed")
              },
              { once: true },
            )
          })
        },
      }
      const inner = Effect.never.pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)))
      const fiber = yield* KiloSnapshotTrack.wrap({
        inner,
        state,
        attempt: KiloSnapshotTrack.makeOperation(),
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 0,
      }).pipe(Effect.forkChild)

      yield* TestClock.adjust(10)
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(aborted)
      yield* Deferred.await(cancelled)

      expect(state.owner).toBeUndefined()
      expect(state.disabledForSession).toBe(false)
      expect(
        yield* KiloSnapshotTrack.wrap({
          inner: fastInner("available-after-interruption"),
          state,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 10,
        }),
      ).toBe("available-after-interruption")
    }),
  )

  test("keeps circuit state isolated by directory", () => {
    const states = KiloSnapshotTrack.makeStates()
    const first = states("/repo/a")
    first.disabledForSession = true

    expect(states("/repo/a")).toBe(first)
    expect(states("/repo/b").disabledForSession).toBe(false)
  })
})

describe("KiloSnapshotTrack.wrap", () => {
  test("returns the hash when inner resolves before the timeout", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: fastInner("fast-hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1000,
      }),
    )

    expect(result).toBe("fast-hash")
    expect(calls.ask).toBe(0)
    expect(calls.persist).toBe(0)
    expect(state.disabledForSession).toBe(false)
    expect(state.asked).toBe(false)
  })

  test("returns undefined immediately when already disabled", async () => {
    const state = KiloSnapshotTrack.makeState()
    state.disabledForSession = true
    const { hooks, calls } = makeHooks("continue")

    // We pass a hang inner to prove it's never started — if the guard
    // didn't short-circuit, this test would time out.
    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 5,
      }),
    )

    expect(result).toBeUndefined()
    expect(calls.ask).toBe(0)
  })

  test('timeout + user answer "continue" joins the fiber and returns its value', async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(80, "finished-late"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )

    expect(result).toBe("finished-late")
    expect(calls.ask).toBe(1)
    expect(calls.persist).toBe(0)
    // After a successful "continue" the guard resets `asked` so a subsequent
    // slow turn still gets the dialog instead of being silently disabled.
    expect(state.asked).toBe(false)
    expect(state.disabledForSession).toBe(false)
  })

  test('timeout + "disable" interrupts, persists, and flips disabledForSession', async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("disable")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBeUndefined()
    expect(calls.ask).toBe(1)
    expect(calls.persist).toBe(1)
    expect(state.disabledForSession).toBe(true)
    expect(state.asked).toBe(true)
  })

  test("disable starts snapshot cancellation before config persistence finishes", async () => {
    const state = KiloSnapshotTrack.makeState()
    const cancelled = Promise.withResolvers<void>()
    const persisting = Promise.withResolvers<void>()
    const persist = Promise.withResolvers<void>()
    const { hooks: base } = makeHooks("disable")
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async persistDisable() {
        await base.persistDisable()
        persisting.resolve()
        await persist.promise
      },
    }
    const inner = Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          cancelled.resolve()
        }),
      ),
    )

    const run = Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner,
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )

    await persisting.promise
    await Effect.runPromise(
      awaitWithTimeout(
        Effect.promise(() => cancelled.promise),
        "snapshot cancellation did not start before config persistence finished",
        Duration.millis(200),
      ),
    )
    persist.resolve()

    expect(await run).toBeUndefined()
  })

  test('timeout + "dismissed" interrupts without disabling or persisting', async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("dismissed")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBeUndefined()
    expect(calls.ask).toBe(1)
    expect(calls.persist).toBe(0)
    expect(state.disabledForSession).toBe(false)
    expect(state.asked).toBe(true)
  })

  test("timeout without sessionID skips the prompt without disabling", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBeUndefined()
    expect(calls.ask).toBe(0)
    expect(calls.persist).toBe(0)
    expect(state.disabledForSession).toBe(false)
    expect(state.asked).toBe(false)
    // No messageID either → progress indicator is suppressed entirely.
    expect(calls.progress).toEqual([])

    const recovered = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: fastInner("recovered-hash"),
        state,
        hooks,
        timeoutMs: 10,
      }),
    )
    expect(recovered).toBe("recovered-hash")
  })

  test("subsequent call after disable returns undefined without starting the inner", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks: firstHooks } = makeHooks("disable")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks: firstHooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )
    expect(state.disabledForSession).toBe(true)

    let innerStarted = false
    const spyingInner = Effect.sync(() => {
      innerStarted = true
      return "should-not-run" as string | undefined
    })
    const { hooks: secondHooks, calls: secondCalls } = makeHooks("continue")

    const secondResult = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: spyingInner,
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks: secondHooks,
        timeoutMs: 10,
      }),
    )

    expect(secondResult).toBeUndefined()
    expect(innerStarted).toBe(false)
    expect(secondCalls.ask).toBe(0)
  })

  test("second slow call after a successful continue re-asks instead of silently disabling", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    // First call: slow → ask → continue → finishes
    const first = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(80, "hash-1"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )
    expect(first).toBe("hash-1")
    expect(calls.ask).toBe(1)
    // Reset semantics: successful continue clears `asked` so a future slow
    // turn gets the dialog again instead of being silently disabled.
    expect(state.asked).toBe(false)
    expect(state.disabledForSession).toBe(false)

    // Second call: still slow → dialog again → user picks continue again → finishes
    const second = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(80, "hash-2"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )
    expect(second).toBe("hash-2")
    expect(calls.ask).toBe(2) // re-asked
    expect(state.disabledForSession).toBe(false)
  })

  test('timeout + snapshot initialization "wait" keeps waiting without asking', async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("disable")

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(50, "managed-hash"),
        state,
        snapshotInitialization: "wait",
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBe("managed-hash")
    expect(calls.ask).toBe(0)
    expect(calls.persist).toBe(0)
    expect(state.disabledForSession).toBe(false)
  })

  test("concurrent timeout does not override an active continue choice", async () => {
    const state = KiloSnapshotTrack.makeState()
    const answer = Promise.withResolvers<KiloSnapshotTrack.Answer>()
    const asked = Promise.withResolvers<void>()
    const { hooks, calls } = makeHooks(answer.promise)
    const firstHooks: KiloSnapshotTrack.Hooks = {
      ...hooks,
      async ask(input) {
        asked.resolve()
        return hooks.ask(input)
      },
    }

    const first = Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(80, "first-hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks: firstHooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )
    await asked.promise
    answer.resolve("continue")

    const second = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )

    expect(second).toBeUndefined()
    expect(await first).toBe("first-hash")
    expect(calls.ask).toBe(1)
    expect(state.disabledForSession).toBe(false)
    expect(state.asked).toBe(false)
    expect(state.owner).toBeUndefined()
  })

  test("cleanup does not clear a newer prompt owner", async () => {
    const state = KiloSnapshotTrack.makeState()
    const replacement = Symbol()
    const { hooks: base } = makeHooks("continue")
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async endProgress(input) {
        state.owner = replacement
        await base.endProgress(input)
      },
    }

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(80, "continued-hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBe("continued-hash")
    expect(state.owner).toBe(replacement)
    expect(state.asked).toBe(true)
  })

  test("continue path keeps `asked` sticky when the fiber finished with no hash", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    // Simulate the fiber eventually completing but with no hash (e.g.
    // snapshot disabled mid-flight or non-git repo). The continue path waits
    // for it, so we get undefined back — and we must not reset `asked`,
    // otherwise repeated failures would keep re-prompting the user every
    // turn.
    const noHashInner = Effect.promise(
      () => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 80)),
    )
    const first = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: noHashInner,
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 20,
        progressDelayMs: 5,
      }),
    )
    expect(first).toBeUndefined()
    expect(calls.ask).toBe(1)
    expect(state.asked).toBe(true)
  })

  test("inner typed failure is caught and returned as undefined", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    // Typed failure — mirrors how the real inner `track()` fails, which is
    // what Effect.catch inside wrap() is designed to handle. Untyped defects
    // (e.g. rejected Promises without Effect.tryPromise) are NOT caught; they
    // propagate and surface as test failures.
    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: failingInner(new Error("boom")),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 100,
      }),
    )

    expect(result).toBeUndefined()
    expect(calls.ask).toBe(0)
    expect(state.disabledForSession).toBe(false)
  })

  test("auto-closes the prompt when the snapshot finishes first", async () => {
    const state = KiloSnapshotTrack.makeState()
    const attempt = KiloSnapshotTrack.makeOperation()
    let aborted = false
    const { hooks: base, calls } = makeHooks("dismissed")
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async ask(_input, signal) {
        return new Promise<KiloSnapshotTrack.Answer>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              resolve("dismissed")
            },
            { once: true },
          )
        })
      },
    }

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(50, "auto-hash"),
        state,
        attempt,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 10,
        progressDelayMs: 0,
      }).pipe(
        Effect.timeoutOrElse({
          duration: "500 millis",
          orElse: () => Effect.succeed("timed-out" as string | undefined),
        }),
      ),
    )

    expect(result).toBe("auto-hash")
    expect(aborted).toBe(true)
    expect(calls.persist).toBe(0)
    expect(state.disabledForSession).toBe(false)
    expect(state.asked).toBe(false)
    expect(state.owner).toBeUndefined()
  })
})

describe("KiloSnapshotTrack progress indicator", () => {
  test("classifies persisted progress as transient", () => {
    const part = KiloSnapshotTrack.progressPart({
      sessionID: SESSION,
      messageID: MESSAGE,
      partID: PartID.make("prt_test"),
      text: "arbitrary status",
    })

    expect(part.synthetic).toBe(true)
    expect(part.ignored).toBe(true)
    expect(part.metadata).toEqual({
      [KiloPartLifecycle.key]: "transient",
      "kilo.snapshot.running": true,
    })
    expect(KiloPartLifecycle.transient(part)).toBe(true)
  })

  test("excludes running progress text from model context but keeps ordinary assistant text", async () => {
    const model = ProviderTest.model()
    const assistant: SessionV1.Assistant = {
      id: MESSAGE,
      sessionID: SESSION,
      role: "assistant",
      parentID: "msg_parent" as MessageID,
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      modelID: model.id,
      providerID: model.providerID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    }
    const progress = KiloSnapshotTrack.progressPart({
      sessionID: SESSION,
      messageID: MESSAGE,
      partID: PartID.make("prt_progress"),
      text: "Initializing snapshot…",
    })
    const messages: SessionV1.WithParts[] = [
      {
        info: assistant,
        parts: [
          progress,
          {
            id: PartID.make("prt_text"),
            sessionID: SESSION,
            messageID: MESSAGE,
            type: "text",
            text: "ordinary assistant text",
          },
        ],
      },
    ]

    const modelMessages = await MessageV2.toModelMessages(messages, model)
    const text = JSON.stringify(modelMessages)
    expect(text).toContain("ordinary assistant text")
    expect(text).not.toContain("Initializing snapshot")
  })

  // Strip the braille spinner frame (first Unicode codepoint, plus the
  // trailing space) so tests can assert on the stable descriptive text
  // without caring which animation frame landed.
  const withoutFrame = (text: string) => text.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/, "")

  test("fast path does NOT publish a progress message (avoids UI flash)", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: fastInner("hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1000,
      }),
    )

    // The 500ms default delay means fast snapshots never emit a start.
    expect(calls.progress).toEqual([])
  })

  test("slow-but-succeeding path (under timeout) starts then ends the indicator", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(200, "late-hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 5_000,
        progressDelayMs: 5,
      }),
    )

    const events = calls.progress
    expect(events.at(0)?.kind).toBe("start")
    expect(events.at(-1)?.kind).toBe("end")

    const firstText = events.at(0) as Extract<(typeof events)[number], { text: string }>
    expect(withoutFrame(firstText.text)).toBe(
      KiloSnapshotTrack.formatProgress(KiloSnapshotTrack.PROGRESS_INITIALIZING, "").trim(),
    )

    // Every "update" event is just an animation tick of the same label — we
    // intentionally do NOT escalate the text after the timeout; the dialog
    // carries the "why", and the in-chat indicator stays short and stable.
    for (const evt of events) {
      if (evt.kind !== "update") continue
      expect(withoutFrame(evt.text)).toBe(
        KiloSnapshotTrack.formatProgress(KiloSnapshotTrack.PROGRESS_INITIALIZING, "").trim(),
      )
    }
  })

  test("failed progress publication does not start update retries", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks: base } = makeHooks("continue")
    let updates = 0
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async startProgress() {
        throw new Error("session service unavailable")
      },
      async updateProgress() {
        updates += 1
      },
    }

    const result = await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(300, "hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1_000,
        progressDelayMs: 2,
      }),
    )

    expect(result).toBe("hash")
    expect(updates).toBe(0)
  })

  test("timed-out path keeps the initializing label (no text escalation)", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(800, "late-hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 200,
        progressDelayMs: 5,
      }),
    )

    const events = calls.progress
    expect(events.at(0)?.kind).toBe("start")
    expect(events.at(-1)?.kind).toBe("end")

    // After the timeout trips, the label should stay on PROGRESS_INITIALIZING.
    // Every emitted event carries the same descriptive text modulo spinner
    // frame, proving we never escalated to a second template.
    const base = KiloSnapshotTrack.formatProgress(KiloSnapshotTrack.PROGRESS_INITIALIZING, "").trim()
    for (const evt of events) {
      if (!("text" in evt)) continue
      expect(withoutFrame(evt.text)).toBe(base)
    }
  })

  test("disable path removes the indicator before returning", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("disable")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: hangInner(),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 200,
        progressDelayMs: 5,
      }),
    )

    expect(calls.progress.at(-1)).toEqual({ kind: "end" })
  })

  test.each(["disable", "dismissed"] as const)(
    "%s path waits for snapshot cleanup before returning",
    async (answer) => {
      const state = KiloSnapshotTrack.makeState()
      const { hooks, calls } = makeHooks(answer)
      const cleaning = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<void>()
      const inner = Effect.never.pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            cleaning.resolve()
            await cleanup.promise
          }),
        ),
      )

      const run = Effect.runPromise(
        KiloSnapshotTrack.wrap({
          inner,
          state,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 20,
          progressDelayMs: 2,
        }),
      )
      const cleaned = await Promise.race([
        cleaning.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
      expect(cleaned).toBe(true)

      const completed = await Promise.race([
        run.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ])
      expect(completed).toBe(false)

      cleanup.resolve()
      await run

      expect(calls.progress.at(-1)).toEqual({ kind: "end" })
    },
  )

  test("stalled progress removal does not block completion and is retried", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks: base, calls } = makeHooks("continue")
    const started = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()
    const snapshot = Promise.withResolvers<string | undefined>()
    let attempts = 0
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async startProgress(input) {
        await base.startProgress(input)
        started.resolve()
      },
      async endProgress(input, signal) {
        attempts += 1
        if (attempts === 3) {
          await base.endProgress(input)
          ended.resolve()
          return
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("stalled removal")), { once: true })
        })
      },
    }

    const run = Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: Effect.promise(() => snapshot.promise),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1_000,
        progressDelayMs: 2,
        progressCleanupTimeoutMs: 5,
      }),
    )

    await started.promise
    snapshot.resolve("hash")
    const result = await Effect.runPromise(
      awaitWithTimeout(
        Effect.promise(() => run),
        "snapshot wrapper waited for progress removal",
      ),
    )
    await Effect.runPromise(
      awaitWithTimeout(
        Effect.promise(() => ended.promise),
        "snapshot progress removal was not retried",
      ),
    )

    expect(result).toBe("hash")
    expect(attempts).toBe(3)
    expect(calls.progress.at(-1)).toEqual({ kind: "end" })
  })

  test("pending progress publication is removed after the snapshot finishes", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks: base, calls } = makeHooks("continue")
    const started = Promise.withResolvers<void>()
    const publish = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()
    const snapshot = Promise.withResolvers<string | undefined>()
    let ends = 0
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async startProgress(input) {
        calls.progress.push({ kind: "start", text: input.text })
        started.resolve()
        await publish.promise
      },
      async endProgress(input) {
        await base.endProgress(input)
        ends += 1
        if (ends === 2) ended.resolve()
      },
    }

    const run = Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: Effect.promise(() => snapshot.promise),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1_000,
        progressDelayMs: 2,
      }),
    )

    await started.promise
    snapshot.resolve("hash")
    expect(await run).toBe("hash")
    publish.resolve()
    await ended.promise

    expect(calls.progress.at(-1)).toEqual({ kind: "end" })
  })

  test("in-flight progress updates cannot recreate a removed indicator", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks: base, calls } = makeHooks("continue")
    const updating = Promise.withResolvers<void>()
    const update = Promise.withResolvers<void>()
    const ended = Promise.withResolvers<void>()
    const snapshot = Promise.withResolvers<string | undefined>()
    let ends = 0
    const hooks: KiloSnapshotTrack.Hooks = {
      ...base,
      async updateProgress(input) {
        updating.resolve()
        await update.promise
        calls.progress.push({ kind: "update", text: input.text })
      },
      async endProgress(input) {
        await base.endProgress(input)
        ends += 1
        if (ends === 2) ended.resolve()
      },
    }

    const run = Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: Effect.promise(() => snapshot.promise),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 1_000,
        progressDelayMs: 2,
      }),
    )

    await updating.promise
    snapshot.resolve("hash")
    expect(await run).toBe("hash")
    update.resolve()
    await ended.promise

    expect(calls.progress.at(-1)).toEqual({ kind: "end" })
  })

  test("missing messageID suppresses the indicator even when slow", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(150, "hash"),
        state,
        sessionID: SESSION,
        hooks,
        timeoutMs: 5_000,
        progressDelayMs: 5,
      }),
    )

    // No messageID → skip the progress indicator entirely.
    expect(calls.progress).toEqual([])
  })

  test("frames cycle through the braille spinner set while animating", async () => {
    const state = KiloSnapshotTrack.makeState()
    const { hooks, calls } = makeHooks("continue")

    // Run long enough to get multiple animation ticks.
    await Effect.runPromise(
      KiloSnapshotTrack.wrap({
        inner: slowInner(500, "hash"),
        state,
        sessionID: SESSION,
        messageID: MESSAGE,
        hooks,
        timeoutMs: 5_000,
        progressDelayMs: 5,
      }),
    )

    const textEvents = calls.progress.filter(
      (e): e is Extract<(typeof calls.progress)[number], { text: string }> => "text" in e,
    )
    const frames = new Set<string>()
    for (const evt of textEvents) {
      const m = evt.text.match(/^([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/)
      if (m) frames.add(m[1])
    }
    // At least two different frames should have been rendered during the run.
    expect(frames.size).toBeGreaterThanOrEqual(2)
  })
})

describe("KiloSnapshotTrack default hooks", () => {
  it.instance(
    "preserves the instance directory for real session progress events",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* requireInstance
        const session = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            Session.Service.use((svc) => svc.create({ title: "snapshot progress" })).pipe(
              Effect.provideService(InstanceRef, ctx),
            ),
          ),
        )
        const message = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            Session.Service.use((svc) =>
              svc.updateMessage({
                id: MESSAGE,
                role: "user",
                sessionID: session.id,
                agent: "build",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              }),
            ).pipe(Effect.provideService(InstanceRef, ctx)),
          ),
        )

        const seen: GlobalEvent[] = []
        const removed = yield* Deferred.make<void>()
        const on = (event: GlobalEvent) => {
          const properties = event.payload?.properties
          if (properties?.sessionID !== session.id && properties?.part?.sessionID !== session.id) return
          seen.push(event)
          if (event.payload?.type === "message.part.removed") Deferred.doneUnsafe(removed, Effect.succeed(undefined))
        }
        GlobalBus.on("event", on)
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            GlobalBus.off("event", on)
            await AppRuntime.runPromise(
              Session.Service.use((svc) => svc.remove(session.id)).pipe(Effect.provideService(InstanceRef, ctx)),
            )
          }),
        )

        const result = yield* KiloSnapshotTrack.wrap({
          inner: slowInner(350, "progress-hash"),
          state: KiloSnapshotTrack.makeState(),
          sessionID: session.id,
          messageID: message.id,
          timeoutMs: 1_000,
          progressDelayMs: 1,
        })

        expect(result).toBe("progress-hash")
        yield* awaitWithTimeout(Deferred.await(removed), "timed out waiting for snapshot progress removal")
        const progress = seen.filter(
          (event) => event.payload?.type === "message.part.updated" || event.payload?.type === "message.part.removed",
        )
        expect(progress.some((event) => event.payload?.type === "message.part.updated")).toBe(true)
        expect(progress.some((event) => event.payload?.type === "message.part.removed")).toBe(true)
        for (const event of progress) expect(event.directory).toBe(test.directory)
      }),
    { git: true },
  )
})

describe("KiloSnapshotTrack persistDisable", () => {
  it.instance(
    "disable writes snapshot:false to the project config",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const state = KiloSnapshotTrack.makeState()
        const hooks: KiloSnapshotTrack.Hooks = {
          ...KiloSnapshotTrack.defaultHooks,
          async ask() {
            return "disable"
          },
          async startProgress() {},
          async updateProgress() {},
          async endProgress() {},
        }

        yield* KiloSnapshotTrack.wrap({
          inner: hangInner(),
          state,
          sessionID: SESSION,
          messageID: MESSAGE,
          hooks,
          timeoutMs: 10,
          progressDelayMs: 2,
        })

        const file = path.join(test.directory, ".kilo", "kilo.jsonc")
        const text = yield* Effect.tryPromise(() => Bun.file(file).text())
        expect(JSON.parse(text).snapshot).toBe(false)
        expect(state.disabledForSession).toBe(true)
      }),
    { git: true },
  )

  test("persistDisable without instance context does not throw", async () => {
    await KiloSnapshotTrack.defaultHooks.persistDisable()
  })
})

describe("KiloSnapshotTrack constants", () => {
  test("TIMEOUT_MS defaults to 45s and respects env override", () => {
    // The constant is evaluated once at module load, so we can only assert
    // on the default in this run. The env override is exercised by running
    // with KILO_SNAPSHOT_TRACK_TIMEOUT_MS, which this test suite does not set.
    expect(KiloSnapshotTrack.TIMEOUT_MS).toBe(45_000)
  })

  test("exposes stable answer labels", () => {
    expect(KiloSnapshotTrack.ANSWER_CONTINUE).toBe("Continue with snapshots")
    expect(KiloSnapshotTrack.ANSWER_DISABLE).toBe("Disable for this project")
  })
})

// Small guard: if Duration is ever swapped out for an incompatible version,
// this will catch it at compile time.
void Duration.millis
