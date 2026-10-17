import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { ConsultAdvisorTool } from "../../../src/kilocode/tool/consult-advisor"
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
