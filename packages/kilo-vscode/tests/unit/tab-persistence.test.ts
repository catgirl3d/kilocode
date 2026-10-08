import { describe, expect, it } from "bun:test"
import { createProjectStore } from "../../webview-ui/agent-manager/project/store"
import { createTabPersistence } from "../../webview-ui/agent-manager/tab-persistence"

describe("createTabPersistence session colors", () => {
  it("updates the project store and posts the color for the session", () => {
    const store = createProjectStore("p")
    const posted: unknown[] = []
    const persistence = createTabPersistence(
      () => store,
      () => "local",
      "review",
      (message) => posted.push(message),
    )

    persistence.tab.setSessionColor("ses-1", "Red")

    expect(store.sessionColors()).toEqual({ "ses-1": "Red" })
    expect(posted).toEqual([{ type: "agentManager.setSessionColor", sessionId: "ses-1", color: "Red" }])

    persistence.tab.setSessionColor("ses-1", null)

    expect(store.sessionColors()).toEqual({})
    expect(posted.at(-1)).toEqual({ type: "agentManager.setSessionColor", sessionId: "ses-1", color: null })
  })
})
