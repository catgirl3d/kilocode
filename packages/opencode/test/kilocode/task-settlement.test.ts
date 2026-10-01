import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KiloTask } from "../../src/kilocode/tool/task"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("KiloTask settlement claim", () => {
  it.instance("claims a job settlement only once per instance", () =>
    Effect.gen(function* () {
      const delivered = yield* KiloTask.makeSettlementState
      expect(yield* KiloTask.claimSettlement(delivered, "job_x", 1)).toBe(true)
      expect(yield* KiloTask.claimSettlement(delivered, "job_x", 1)).toBe(false)
    }),
  )

  it.instance("claims a resumed run of the same task as a new settlement", () =>
    Effect.gen(function* () {
      const delivered = yield* KiloTask.makeSettlementState
      expect(yield* KiloTask.claimSettlement(delivered, "job_x", 1)).toBe(true)
      expect(yield* KiloTask.claimSettlement(delivered, "job_x", 2)).toBe(true)
    }),
  )
})
