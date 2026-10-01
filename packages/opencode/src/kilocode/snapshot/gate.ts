// kilocode_change - new file
import { Deferred, Effect, Exit, Semaphore } from "effect"
import type { MessageID, PartID, SessionID } from "@/session/schema"

type Track = (input: {
  sessionID: SessionID
  messageID: MessageID
  snapshotInitialization?: "wait"
}) => Effect.Effect<string | undefined>

export namespace KiloSnapshotGate {
  export type Step = {
    id: PartID
    messageID: MessageID
    sessionID: SessionID
    type: "step-start"
    snapshot?: string
    time: { start: number | undefined }
  }

  export type Patch = { hash: string; files: string[] }

  export type Input = {
    sessionID: SessionID
    messageID?: MessageID
    baseline?: string
    snapshotInitialization?: "wait"
    track: Track
    patch: (baseline: string, after: string) => Effect.Effect<Patch>
    updatePart: (part: Step) => Effect.Effect<Step>
    persist: (input: { messageID: MessageID; snapshot: string; patch: Patch; append: boolean }) => Effect.Effect<void>
  }

  export type Checkpoint = {
    messageID?: MessageID
    append?: boolean
  }

  export type Owner = {
    startStep: (step: Step) => Effect.Effect<void>
    ensure: (messageID?: MessageID) => Effect.Effect<string | undefined>
    finishStep: () => Effect.Effect<void>
    restore: (baseline?: string, tried?: boolean) => Effect.Effect<void>
    checkpoint: (input?: Checkpoint) => Effect.Effect<void>
    observe: (id: string, start: (settle: Effect.Effect<void>) => Effect.Effect<void>) => Effect.Effect<void>
  }

  // fork_change start - [fork] retain one lazy baseline across prompt model and tool steps
  export const make = (input: Input): Owner => {
    let attempted = Boolean(input.baseline)
    let baseline = input.baseline
    let anchor = input.messageID
    let part: Step | undefined
    let flight: Deferred.Deferred<string | undefined> | undefined
    const sem = Semaphore.makeUnsafe(1)
    let pending = false
    let anchored = Boolean(input.baseline)
    let dirty = false
    const observers = new Set<string>()

    const update = (hash: string) => {
      baseline = hash
      if (!part || anchored) {
        pending = !anchored
        return Effect.void
      }
      part = { ...part, snapshot: hash }
      anchored = true
      pending = false
      return input.updatePart(part)
    }

    const startStep = (value: Step) =>
      Effect.gen(function* () {
        anchor = value.messageID
        part = value
        if (baseline && pending) yield* update(baseline)
        else yield* input.updatePart(value)
      })

    const ensure = Effect.fn("KiloSnapshotGate.ensure")(function* (messageID?: MessageID) {
      if (messageID) anchor = messageID
      if (baseline) {
        dirty = true
        return baseline
      }
      if (attempted) return flight ? yield* Deferred.await(flight) : undefined
      const id = anchor
      if (!id) return undefined

      attempted = true
      const deferred = yield* Deferred.make<string | undefined>()
      flight = deferred
      const result = yield* input
        .track({ sessionID: input.sessionID, messageID: id, snapshotInitialization: input.snapshotInitialization })
        .pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.tap((value) => Deferred.succeed(deferred, value)),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(deferred, undefined)
              if (flight === deferred) flight = undefined
            }),
          ),
        )
      if (!result) return undefined
      dirty = true
      yield* update(result)
      return result
    })

    const finishStep = Effect.fn("KiloSnapshotGate.finishStep")(function* () {
      if (flight) yield* Deferred.await(flight)
      part = undefined
    })

    const restore = (value?: string, tried?: boolean) =>
      Effect.sync(() => {
        if (baseline) return
        if (value) {
          baseline = value
          attempted = true
          anchored = true
          return
        }
        if (tried) attempted = true
      })

    const checkpoint = Effect.fn("KiloSnapshotGate.checkpoint")(function* (opts: Checkpoint = {}) {
      yield* sem.withPermits(1)(
        Effect.gen(function* () {
          if (flight) yield* Deferred.await(flight)
          const before = baseline
          if (!before || (!opts.append && !dirty)) return
          const messageID = opts.messageID ?? anchor
          if (!messageID) return
          if (!opts.append) dirty = false
          yield* Effect.gen(function* () {
            const after = yield* input
              .track({ sessionID: input.sessionID, messageID, snapshotInitialization: input.snapshotInitialization })
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            if (!after) return false
            const diff = yield* input.patch(before, after)
            yield* input.persist({ messageID, snapshot: after, patch: diff, append: opts.append === true })
            return true
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (!opts.append && (!Exit.isSuccess(exit) || !exit.value)) dirty = true
              }),
            ),
          )
        }),
      )
    })

    const observe = (id: string, start: (settle: Effect.Effect<void>) => Effect.Effect<void>) =>
      Effect.suspend(() => {
        if (observers.has(id)) return Effect.void
        observers.add(id)
        const settle = Effect.sync(() => observers.delete(id)).pipe(Effect.asVoid)
        return start(settle).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* settle
              return yield* Effect.failCause(cause)
            }),
          ),
        )
      })

    return { startStep, ensure, finishStep, restore, checkpoint, observe }
  }
  // fork_change end
}
