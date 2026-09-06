import { describe, expect, it } from "bun:test"
import { createSessionVariants } from "../../webview-ui/src/context/session-variants"
import type { ExtensionMessage, ModelSelection } from "../../webview-ui/src/types/messages"

const model: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }

function setup(session?: string, configured?: string) {
  const config = { model: "anthropic/claude-sonnet-4", variant: configured }
  const selections: Record<string, string> = {}
  const messages: Array<{ type: string; key?: string; value?: string }> = []
  const order: string[] = []
  let handler: ((message: ExtensionMessage) => void) | undefined
  const variants = createSessionVariants({
    selections: () => selections,
    set: (key, value) => {
      selections[key] = value
    },
    selected: () => model,
    session: () => session,
    agent: () => "code",
    config: () => config,
    find: () => ({ variants: { low: {}, high: {}, max: {} } }),
    post: (message) => {
      order.push("post")
      messages.push(message)
    },
    listen: (next) => {
      order.push("listen")
      handler = next
      return () => order.push("unsub")
    },
  })
  return { variants, config, selections, messages, order, dispatch: (message: ExtensionMessage) => handler?.(message) }
}

describe("session variants", () => {
  it("subscribes before requesting persisted variants and returns cleanup", () => {
    const state = setup()
    const unsub = state.variants.load()
    expect(state.order).toEqual(["listen", "post"])
    expect(state.messages).toEqual([{ type: "requestVariants" }])
    unsub()
    expect(state.order).toEqual(["listen", "post", "unsub"])
  })

  it("loads global variants without restoring stale session variants", () => {
    const state = setup()
    state.variants.load()
    state.dispatch({
      type: "variantsLoaded",
      variants: { "agent/code/anthropic/claude-sonnet-4": "high", "session/old/model": "low" },
    })
    expect(state.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
  })

  it("restores an agent/model choice for a fresh task after loading", () => {
    const state = setup("pending-new", "high")
    state.variants.load()
    state.dispatch({
      type: "variantsLoaded",
      variants: { "agent/code/anthropic/claude-sonnet-4": "max" },
    })

    expect(state.variants.current()).toBe("max")
    expect(state.variants.request()).toBe("max")
  })

  it("uses the configured agent variant when no picker selection exists", () => {
    const state = setup(undefined, "max")
    expect(state.variants.agent("code", model)).toBe("max")
    expect(state.variants.current()).toBe("max")
    expect(state.variants.request()).toBe("max")
  })

  it("prefers remembered picker choices over configured defaults for new tabs", () => {
    const state = setup("pending-new", "high")
    state.selections["agent/code/anthropic/claude-sonnet-4"] = "low"
    expect(state.variants.current()).toBe("low")
    state.config.variant = "max"
    expect(state.variants.current()).toBe("low")
    expect(state.variants.request()).toBe("low")
    expect(state.variants.agent("code", model)).toBe("low")
  })

  it("does not apply a configured variant to another model", () => {
    const state = setup("pending-new", "max")
    state.config.model = "anthropic/another-model"
    expect(state.variants.current()).toBeUndefined()
    expect(state.variants.agent("code", model)).toBeUndefined()
  })

  it("persists an explicit model default for future tasks", () => {
    const state = setup("session-a", "max")
    state.variants.select(undefined)
    expect(state.variants.current()).toBeUndefined()
    expect(state.variants.request()).toBe("")
    expect(state.variants.current("session-b")).toBeUndefined()
    expect(state.variants.request("session-b")).toBe("")
    expect(state.messages).toEqual([{ type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "" }])
  })

  it("persists an active Default choice when a remembered choice exists", () => {
    const state = setup("session-a", "max")
    state.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    state.variants.select(undefined)

    expect(state.variants.current()).toBeUndefined()
    expect(state.variants.current("pending-new")).toBeUndefined()
    expect(state.selections).toEqual({
      "session/session-a/anthropic/claude-sonnet-4": "",
      "agent/code/anthropic/claude-sonnet-4": "",
    })
    expect(state.messages).toEqual([{ type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "" }])
  })

  it.each(["sidebar-pending:new", "pending:new"])("persists a pre-submit Default choice for %s", (id) => {
    const state = setup(undefined, "max")
    state.variants.select(undefined, id)
    expect(state.variants.current(id)).toBeUndefined()
    expect(state.variants.request(id)).toBe("")
    expect(state.variants.current("another-draft")).toBeUndefined()
    expect(state.messages).toEqual([{ type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "" }])
  })

  it("persists explicit selections for future tasks", () => {
    const global = setup()
    global.variants.select("high")
    expect(global.messages).toEqual([
      { type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "high" },
    ])
    expect(global.variants.current("pending-new")).toBe("high")

    const scoped = setup("session-a")
    scoped.variants.select("low")
    expect(scoped.selections).toEqual({
      "session/session-a/anthropic/claude-sonnet-4": "low",
      "agent/code/anthropic/claude-sonnet-4": "low",
    })
    expect(scoped.messages).toEqual([
      { type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "low" },
    ])
  })

  it("restores an active picker choice in a new task", () => {
    const state = setup("session-a", "high")
    state.variants.select("max")

    expect(state.variants.current("pending-new")).toBe("max")
    expect(state.variants.request("pending-new")).toBe("max")
  })

  it("keeps non-persistent overrides scoped to the current task", () => {
    const state = setup("session-a", "high")
    state.variants.select("max", "session-a", false)

    expect(state.selections).toEqual({ "session/session-a/anthropic/claude-sonnet-4": "max" })
    expect(state.messages).toEqual([])
    expect(state.variants.current("pending-new")).toBe("high")
  })

  it("persists an explicit default selection", () => {
    const state = setup()
    state.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    state.variants.select(undefined)
    expect(state.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "" })
    expect(state.variants.current()).toBeUndefined()
    expect(state.messages).toEqual([{ type: "persistVariant", key: "agent/code/anthropic/claude-sonnet-4", value: "" }])
  })

  it("does not shadow a cached variant when carrying the model default", () => {
    const global = setup()
    global.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    global.variants.carry(model, undefined, "code")
    expect(global.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
    expect(global.messages).toEqual([])

    const session = setup("session-a")
    session.selections["agent/code/anthropic/claude-sonnet-4"] = "high"
    session.variants.carry(model, undefined, "code", "session-a")
    expect(session.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": "high" })
    expect(session.variants.current()).toBe("high")
  })

  it.each(["high", ""])("does not overwrite a remembered target variant when carrying %s", (value) => {
    const state = setup("session-a")
    state.selections["agent/code/anthropic/claude-sonnet-4"] = value
    state.variants.carry(model, "max", "code", "session-a")

    expect(state.selections).toEqual({ "agent/code/anthropic/claude-sonnet-4": value })
    expect(state.messages).toEqual([])
  })
})
