import { describe, expect, it } from "bun:test"
import { createSessionRecovery } from "../../webview-ui/src/context/session-recovery"
import { createSessionVariants } from "../../webview-ui/src/context/session-variants"
import { variantKey } from "../../webview-ui/src/context/session-variant-store"
import type { Message, ModelSelection, SessionInfo } from "../../webview-ui/src/types/messages"

const model: ModelSelection = { providerID: "openai", modelID: "gpt-5.5" }
const id = "session-a"

function message(variant?: string): Message {
  return {
    id: "message-a",
    sessionID: id,
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    agent: "code",
    model: variant === undefined ? model : { ...model, variant },
  }
}

function info(variant?: string): SessionInfo {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agent: "code",
    model: variant === undefined ? model : { ...model, variant },
  }
}

function setup() {
  const selections: Record<string, string> = {}
  const writes: Array<{ key: string; value: string }> = []
  const session = createSessionVariants({
    selections: () => selections,
    set: (key, value) => {
      selections[key] = value
    },
    selected: () => model,
    session: () => id,
    agent: () => "code",
    config: () => undefined,
    find: () => ({ variants: { high: {}, max: {} } }),
    post: () => undefined,
    listen: () => () => undefined,
    draft: () => false,
    remember: () => undefined,
  })
  const recovery = createSessionRecovery({
    store: { agentSelections: {}, sessionOverrides: {}, variantSelections: selections },
    select: () => undefined,
    pick: () => undefined,
    variant: (key, value) => {
      writes.push({ key, value })
      selections[key] = value
    },
    agent: () => "code",
    names: () => new Set(["code"]),
  })
  return { recovery, selections, session, writes }
}

describe("session recovery", () => {
  it("keeps the remembered effort when session info has no variant", () => {
    const state = setup()
    state.selections[variantKey(model, "code")] = "max"

    state.recovery.info(info())

    expect(state.writes).toEqual([])
    expect(state.selections).toEqual({ [variantKey(model, "code")]: "max" })
    expect(state.session.current(id)).toBe("max")
  })

  it("preserves an explicit Default from message history", () => {
    const state = setup()

    state.recovery.messages(id, [message("")])

    expect(state.writes).toEqual([{ key: variantKey(model, "code", id), value: "" }])
    expect(state.selections[variantKey(model, "code", id)]).toBe("")
    expect(state.session.current(id)).toBeUndefined()
  })
})
