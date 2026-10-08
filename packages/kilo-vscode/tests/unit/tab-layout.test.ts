import { describe, expect, it } from "bun:test"
import type { Memento } from "vscode"
import { handleTabLayoutMessage } from "../../src/agent-manager/tab-layout"
import { initSessionColors, sessionColors } from "../../src/session-colors"

const fakeMemento = () => {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value)
    },
    keys: () => [...data.keys()],
    setKeysForSync: () => {},
  } as unknown as Memento
}

describe("handleTabLayoutMessage session colors", () => {
  it("forwards agentManager.setSessionColor into the shared store without project state", async () => {
    initSessionColors(fakeMemento())

    expect(
      handleTabLayoutMessage(undefined, { type: "agentManager.setSessionColor", sessionId: "ses-1", color: "Red" }),
    ).toBe(true)
    await Bun.sleep(0)

    expect(sessionColors()).toEqual({ "ses-1": "Red" })
  })

  it("clears a color through the same route", async () => {
    initSessionColors(fakeMemento())
    handleTabLayoutMessage(undefined, { type: "agentManager.setSessionColor", sessionId: "ses-1", color: "Red" })
    await Bun.sleep(0)

    handleTabLayoutMessage(undefined, { type: "agentManager.setSessionColor", sessionId: "ses-1", color: null })
    await Bun.sleep(0)

    expect(sessionColors()).toEqual({})
  })

  it("leaves other messages unhandled", () => {
    expect(handleTabLayoutMessage(undefined, { type: "agentManager.requestState" })).toBe(false)
  })
})
