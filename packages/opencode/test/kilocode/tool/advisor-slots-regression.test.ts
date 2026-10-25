import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { ConsultAdvisorTool } from "../../../src/kilocode/tool/consult-advisor"
import { select } from "../../../src/kilocode/tool/advisor-slots"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { MessageID, SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { Truncate } from "../../../src/tool/truncate"
import { Tool } from "../../../src/tool/tool"
import { testEffect } from "../../lib/effect"

const agent: Agent.Info = { name: "build", mode: "primary", permission: [], options: {} }

const state = {
  experimental: {} as Record<string, unknown>,
  streams: [] as LLM.StreamInput[],
}

const layer = Layer.mergeAll(
  AppNodeBuilder.build(Truncate.node),
  Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
  Layer.mock(Config.Service, {
    get: () => Effect.sync(() => ({ experimental: state.experimental }) as unknown as Config.Info),
  }),
  Layer.mock(Provider.Service, {
    getModel: (providerID, modelID) =>
      Effect.succeed({ providerID, id: modelID, variants: {} } as unknown as Provider.Model),
  }),
  Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as unknown as Session.Info) }),
  Layer.mock(LLM.Service, {
    stream: (input: LLM.StreamInput) => {
      state.streams.push(input)
      return Stream.make(
        LLMEvent.textStart({ id: "text" }),
        LLMEvent.textDelta({ id: "text", text: "guidance" }),
        LLMEvent.textEnd({ id: "text" }),
      )
    },
  }),
)

const it = testEffect(layer)

function configure(experimental: Record<string, unknown>) {
  state.streams.length = 0
  state.experimental = experimental
}

function context(sessionID: string): Tool.Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_advisor"),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("advisor slot selection bounds", () => {
  it.effect("rejects an empty or oversized advisors selection before contacting any advisor", () =>
    Effect.gen(function* () {
      configure({ advisors: [{ name: "security", model: "prov/sec" }] })
      const tool = yield* Tool.init(yield* ConsultAdvisorTool)

      for (const advisors of [[], ["security", "security", "security", "security"]]) {
        const exit = yield* tool.execute({ advisors }, context(`ses_regression_${advisors.length}`)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Tool.InvalidArgumentsError)
        }
      }

      expect(state.streams).toEqual([])
    }),
  )
})

describe("advisor slot input normalization", () => {
  const security = { name: "security", model: "prov/sec" }
  const fast = { name: "fast", model: "prov/fast" }
  const slots = [security, fast]

  test("accepts a JSON-encoded array, a single name, and the all sentinel", () => {
    expect(select(slots, '["security"]')).toEqual({ slots: [security] })
    expect(select(slots, "security")).toEqual({ slots: [security] })
    expect(select(slots, '["security","fast"]')).toEqual({ slots: [security, fast] })
    expect(select(slots, ["all"])).toEqual({ slots })
    expect(select(slots, "all")).toEqual({ slots })
    expect(select(slots, '["missing"]')).toEqual({ unknown: "missing" })
  })

  it.effect("accepts a JSON-encoded advisors array and a single advisor name", () =>
    Effect.gen(function* () {
      configure({ advisors: [{ name: "security", model: "prov/sec" }] })
      const tool = yield* Tool.init(yield* ConsultAdvisorTool)

      for (const [index, advisors] of ['["security"]', "security", "all", '["all"]'].entries()) {
        state.streams.length = 0
        const result = yield* tool.execute({ advisors }, context(`ses_regression_normalized_${index}`))
        expect(result.title).toBe("Advisor completed")
        expect(state.streams).toHaveLength(1)
      }
    }),
  )

  it.effect("exposes an array-only advisors schema to the model", () =>
    Effect.gen(function* () {
      configure({ advisors: [{ name: "security", model: "prov/sec" }] })
      const tool = yield* Tool.init(yield* ConsultAdvisorTool)
      const advisors = tool.jsonSchema?.properties?.["advisors"] as unknown as
        | { type?: string; anyOf?: unknown; items?: { type?: string } }
        | undefined

      expect(advisors?.type).toBe("array")
      expect(advisors?.items?.type).toBe("string")
      expect(advisors?.anyOf).toBeUndefined()
    }),
  )
})
