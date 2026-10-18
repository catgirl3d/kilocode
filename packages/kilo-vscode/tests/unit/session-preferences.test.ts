import { describe, expect, it } from "bun:test"
import { resolveInfoPrefs, resolveMessagePrefs } from "../../webview-ui/src/context/session-preferences"
import type { Message } from "../../webview-ui/src/types/messages"

function msg(input: Partial<Message>): Message {
  return {
    id: input.id ?? "msg",
    sessionID: input.sessionID ?? "session-a",
    role: input.role ?? "user",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...input,
  }
}

const agents = new Set(["code", "ask"])

describe("session preference recovery", () => {
  it("recovers each agent's latest user message", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({
          id: "old",
          agent: "ask",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "low" },
        }),
        msg({
          id: "new",
          agent: "code",
          model: { providerID: "openai", modelID: "gpt-5.5", variant: "medium" },
        }),
      ],
      agents,
    )

    expect(prefs.agent).toBe("code")
    expect(prefs.picks).toEqual({
      ask: { model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: "low", seq: 1 },
      code: { model: { providerID: "openai", modelID: "gpt-5.5" }, variant: "medium", seq: 0 },
    })
  })

  it("leaves the effort unset when the newest message has no variant", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({ agent: "code", model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
        msg({ agent: "code", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }),
      ],
      agents,
    )

    expect(prefs.picks.code).toEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      variant: undefined,
      seq: 0,
    })
  })

  it("keeps an explicit empty Default from the newest message", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({ agent: "code", model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
        msg({ agent: "code", model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "" } }),
      ],
      agents,
    )

    expect(prefs.picks.code).toEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      variant: "",
      seq: 0,
    })
  })

  it("ignores assistant-only model data and invalid agents", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({
          role: "assistant",
          agent: "task",
          model: { providerID: "openai", modelID: "gpt-5.5", variant: "high" },
        }),
      ],
      agents,
    )

    expect(prefs.agent).toBeUndefined()
    expect(prefs.picks).toEqual({})
    expect(prefs.unattributed).toBeUndefined()
  })

  it("keeps agentless user messages for the session's current agent", () => {
    const prefs = resolveMessagePrefs(
      [msg({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } })],
      agents,
    )

    expect(prefs.unattributed).toEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      variant: "high",
      seq: 0,
    })
  })

  it("can recover the latest valid agent separately from the latest user model", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({ agent: "ask", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }),
        msg({ role: "assistant", agent: "code" }),
      ],
      agents,
    )

    expect(prefs.agent).toBe("code")
    expect(prefs.picks).toEqual({
      ask: { model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: undefined, seq: 1 },
    })
  })

  it("prefers the newer agentless message over an older attributed one", () => {
    const prefs = resolveMessagePrefs(
      [
        msg({ agent: "code", model: { providerID: "openai", modelID: "gpt-5.5" } }),
        msg({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
      ],
      agents,
    )

    expect(prefs.agent).toBe("code")
    expect(prefs.picks.code?.seq).toBe(1)
    expect(prefs.unattributed?.seq).toBe(0)
  })
})

describe("session info recovery", () => {
  it("recovers the agent, model and effort a server session last ran with", () => {
    expect(
      resolveInfoPrefs({ agent: "ask", model: { providerID: "openai", modelID: "gpt-5.5", variant: "high" } }, agents),
    ).toEqual({ agent: "ask", model: { providerID: "openai", modelID: "gpt-5.5" }, variant: "high" })
  })

  it("leaves the effort unset when a server session has no variant", () => {
    expect(resolveInfoPrefs({ agent: "code", model: { providerID: "openai", modelID: "gpt-5.5" } }, agents)).toEqual({
      agent: "code",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: undefined,
    })
  })

  it("keeps the agent alone when the session has no model yet", () => {
    expect(resolveInfoPrefs({ agent: "code" }, agents)).toEqual({ agent: "code" })
  })

  it("ignores unknown or missing agents so a model is never attributed to the wrong agent", () => {
    const model = { providerID: "openai", modelID: "gpt-5.5" }
    expect(resolveInfoPrefs({ agent: "task", model }, agents)).toBeUndefined()
    expect(resolveInfoPrefs({ model }, agents)).toBeUndefined()
  })
})
