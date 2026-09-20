// kilocode_change - new file
import { Deferred, Effect } from "effect"
import type { MessageID, PartID, SessionID } from "@/session/schema"

type Track = (input: {
  sessionID: SessionID
  messageID: MessageID
  snapshotInitialization?: "wait"
}) => Effect.Effect<string | undefined>

export namespace KiloSnapshotGate {
  export type Input = {
    sessionID: SessionID
    messageID: MessageID
    snapshotInitialization?: "wait"
    track: Track
    updatePart: (part: Step) => Effect.Effect<Step>
  }

  export type Step = {
    id: PartID
    messageID: MessageID
    sessionID: SessionID
    type: "step-start"
    snapshot?: string
    time: { start: number | undefined }
  }

  export type Result = {
    baseline?: string
    finish?: string
  }

  export const make = (input: Input) => {
    let active = true
    let attempted = false
    let baseline: string | undefined
    let part: Step | undefined
    let flight: Deferred.Deferred<string | undefined> | undefined

    const update = (hash: string) => {
      baseline = hash
      if (!part) return Effect.void
      part = { ...part, snapshot: hash }
      return input.updatePart(part)
    }

    const startStep = (value: Step) =>
      Effect.gen(function* () {
        if (!active) {
          active = true
          attempted = false
          baseline = undefined
          flight = undefined
        }
        part = value
        if (baseline) yield* update(baseline)
        else yield* input.updatePart(value)
      })

    const ensure = Effect.fn("KiloSnapshotGate.ensure")(function* () {
      if (!active) {
        active = true
        attempted = false
        baseline = undefined
      }
      if (baseline) return baseline
      if (attempted) return flight ? yield* Deferred.await(flight) : undefined

      attempted = true
      const deferred = yield* Deferred.make<string | undefined>()
      flight = deferred
      const result = yield* input
        .track({
          sessionID: input.sessionID,
          messageID: input.messageID,
          snapshotInitialization: input.snapshotInitialization,
        })
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      yield* Deferred.succeed(deferred, result)
      flight = undefined
      if (!result) return undefined
      yield* update(result)
      return result
    })

    const finishStep = Effect.fn("KiloSnapshotGate.finishStep")(function* () {
      const before = baseline ?? (flight ? yield* Deferred.await(flight) : undefined)
      const result = before
        ? yield* input
            .track({
              sessionID: input.sessionID,
              messageID: input.messageID,
              snapshotInitialization: input.snapshotInitialization,
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      active = false
      attempted = false
      baseline = undefined
      part = undefined
      flight = undefined
      return { baseline: before, finish: result }
    })

    return { startStep, ensure, finishStep }
  }
}
