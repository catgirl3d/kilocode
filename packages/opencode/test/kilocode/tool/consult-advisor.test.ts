import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { ConsultAdvisorTool, acquire, release } from "../../../src/kilocode/tool/consult-advisor"
import { Provider } from "../../../src/provider/provider"
import { LLM } from "../../../src/session/llm"
import { MessageID, SessionID } from "../../../src/session/schema"
import { Session } from "../../../src/session/session"
import { Truncate } from "../../../src/tool/truncate"
import { Tool } from "../../../src/tool/tool"
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

function layer(variant: string, streams: LLM.StreamInput[]) {
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
        return Stream.make(LLMEvent.textDelta({ id: "block", text: "guidance" }))
      },
    }),
  )
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

const blocked: LLM.StreamInput[] = []
const itBlocked = testEffect(layer("bogus", blocked))

itBlocked.effect("reports an unavailable configured variant without contacting the LLM", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_blocked"))

    expect(result.title).toBe("Advisor unavailable")
    expect(result.output).toContain("The configured advisor variant is unavailable: bogus")
    expect(result.output).toContain("Available variants: low, high")
    expect(blocked).toEqual([])
  }),
)

const requested: LLM.StreamInput[] = []
const itStreams = testEffect(layer("high", requested))

itStreams.effect("streams one guidance consultation with the resolved variant", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* ConsultAdvisorTool)
    const result = yield* tool.execute({ question: "review" }, context("ses_stream"))

    expect(result.title).toBe("Advisor guidance")
    expect(result.output).toBe("guidance")
    expect(requested).toEqual([
      expect.objectContaining({
        sessionID: "ses_stream-advisor",
        parentSessionID: "ses_stream",
        toolChoice: "none",
        tools: {},
        retries: 0,
        agent: expect.objectContaining({ name: "advisor" }),
        user: expect.objectContaining({
          agent: "advisor",
          model: expect.objectContaining({ providerID: "prov", modelID: "model", variant: "high" }),
        }),
      }),
    ])
  }),
)
