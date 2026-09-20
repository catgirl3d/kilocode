// fork_change - new file
import { describe, expect, it } from "bun:test"
import { createSessionVariants } from "../../webview-ui/src/context/session-variants"
import { createModelSelector } from "../../webview-ui/src/context/session-model-selector"
import { createSessionModelActions } from "../../webview-ui/src/context/session-model-actions"
import type { ExtensionMessage, ModelSelection } from "../../webview-ui/src/types/messages"

const a: ModelSelection = { providerID: "p", modelID: "a" }
const b: ModelSelection = { providerID: "p", modelID: "b" }
const c: ModelSelection = { providerID: "p", modelID: "c" }

function setup() {
  const variants: Record<string, string> = { "agent/code/p/a": "max" }
  const remembered: Array<{ agent: string; model: ModelSelection; value: string | undefined }> = []
  const messages: Array<Extract<ExtensionMessage, { type: "persistVariant" }>> = []
  const current: { model: ModelSelection } = { model: a }
  const currentSessionID: { id: string | undefined } = { id: undefined }
  const findModel = (sel: ModelSelection | null) =>
    sel?.modelID === "a"
      ? { variants: { high: {}, max: {} } }
      : sel?.modelID === "c"
        ? { variants: { low: {}, high: {} } }
        : { variants: { high: {} } }
  const session = createSessionVariants({
    selections: () => variants,
    set: (key, value) => {
      variants[key] = value
    },
    selected: () => current.model,
    session: () => undefined,
    agent: () => "code",
    config: () => undefined,
    find: findModel,
    post: (message) => {
      if (message.type === "persistVariant") messages.push(message)
    },
    listen: () => () => undefined,
    remember: () => undefined,
  })
  const selector = createModelSelector({
    current: () => undefined,
    agent: () => "code",
    selected: () => current.model,
    variant: session.choice,
    apply: (_agent, selection) => {
      current.model = selection
    },
    set: () => undefined,
    carry: session.carry,
    hide: () => undefined,
  })
  const actions = createSessionModelActions({
    select: selector.select,
    agentForScope: () => "code",
    currentSessionID: () => currentSessionID.id,
    variantSelections: () => variants,
    variantForAgent: session.agent,
    findModel,
    rememberSelection: (agent, model, value) => {
      remembered.push({ agent, model, value })
    },
  })
  return { actions, variants, remembered, messages, current, currentSessionID }
}

describe("session model actions", () => {
  it("restores the remembered max when switching back from a high-only model", () => {
    const state = setup()
    state.actions.selectModel("p", "b", undefined, true)
    expect(state.current.model).toEqual(b)
    expect(state.variants["agent/code/p/b"]).toBe("high")
    expect(state.remembered.at(-1)).toEqual({ agent: "code", model: b, value: "high" })

    state.actions.selectModel("p", "a", undefined, true)
    expect(state.variants["agent/code/p/a"]).toBe("max")
    expect(state.remembered.at(-1)).toEqual({ agent: "code", model: a, value: "max" })
  })

  it("does not add persist messages when returning to a remembered model", () => {
    const state = setup()
    state.actions.selectModel("p", "b", undefined, true)
    const count = state.messages.length

    state.actions.selectModel("p", "a", undefined, true)
    expect(state.messages.length).toBe(count)
    expect(state.messages.every((m) => m.value !== "max" || m.key.includes("/p/a"))).toBe(true)
  })

  it("prefers the target model's own pending memory over its agent memory", () => {
    const state = setup()
    state.variants["session/sidebar-pending:x/p/c"] = "max"
    state.variants["agent/code/p/c"] = "low"
    state.actions.selectModel("p", "c", "sidebar-pending:x", true)

    expect(state.remembered.at(-1)).toEqual({ agent: "code", model: c, value: "high" })
  })

  it("maps a stale remembered variant onto the target model's supported efforts", () => {
    const state = setup()
    state.variants["agent/code/p/b"] = "max"
    state.actions.selectModel("p", "b", undefined, true)

    expect(state.remembered.at(-1)).toEqual({ agent: "code", model: b, value: "high" })
  })

  it("does not remember a preference when switching inside a live session", () => {
    const state = setup()
    state.currentSessionID.id = "session-1"
    state.actions.selectModel("p", "b", "session-1", true)

    expect(state.current.model).toEqual(b)
    expect(state.remembered).toEqual([])
  })

  it("skips remembering for temporary overrides without a session", () => {
    const state = setup()
    state.actions.selectModel("p", "b", undefined, false)

    expect(state.current.model).toEqual(b)
    expect(state.remembered).toEqual([])
  })
})
