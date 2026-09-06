import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "../..")
const app = readFileSync(join(root, "webview-ui/agent-manager/AgentManagerApp.tsx"), "utf8")
const history = readFileSync(join(root, "webview-ui/src/components/history/SessionList.tsx"), "utf8")

describe("Agent Manager session state regressions", () => {
  it("does not expand the sidebar when creating a session", () => {
    const start = app.indexOf("const handleAddSession = () =>")
    const end = app.indexOf("const selectChatSession", start)
    const handler = app.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(handler).not.toContain("expandSidebar()")
    expect(handler).toContain("addPendingTab()")
  })

  it("restores history scroll and focus after deleting a session", () => {
    const start = history.indexOf("function confirmDelete")
    const end = history.indexOf("function wrapItem", start)
    const handler = history.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(handler).toContain("top = scroller()?.scrollTop ?? 0")
    expect(handler).toContain("target.scrollTo(0, top)")
    expect(handler).toContain("preventScroll: true")
  })
})
