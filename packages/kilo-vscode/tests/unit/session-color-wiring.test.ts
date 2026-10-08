import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8").replace(/\s+/g, " ")

// Source-level tripwires for the session-color feature: a rebase or merge that
// silently drops one of these hooks must fail here even when no behavior test
// exercises the exact provider boundary.
describe("session color wiring stays in place", () => {
  it("binds the store during activation", () => {
    expect(source("src/extension.ts")).toContain("initSessionColors(context.globalState)")
  })

  it("keeps the sidebar provider subscription, callbacks and disposal", () => {
    const provider = source("src/KiloProvider.ts")

    expect(provider).toContain(
      'this.unsubscribeSessionColors = onSessionColorsChanged((colors) => { this.postMessage({ type: "sessionColorsLoaded", colors }) })',
    )
    expect(provider).toContain(
      'sessionColors: () => this.postMessage({ type: "sessionColorsLoaded", colors: sessionColors() })',
    )
    expect(provider).toContain("setSessionColor: (sessionID, color) => setSessionColor(sessionID, color)")
    expect(provider).toContain("this.unsubscribeSessionColors?.()")
  })

  it("keeps the Agent Manager state push, change subscription and teardown order", () => {
    const provider = source("src/agent-manager/AgentManagerProvider.ts")

    expect(provider).toContain("sessionColors: sessionColors(),")
    expect(provider).toContain("private unsubColors = onSessionColorsChanged(() => this.pushState())")
    const dispose = provider.slice(provider.indexOf("private async disposeAsync"))
    expect(dispose).toContain("this.unsubColors?.()")
    expect(dispose.indexOf("this.unsubColors?.()")).toBeLessThan(dispose.indexOf("await this.stateReady"))
  })

  it("keeps both color menus on the shared palette component", () => {
    expect(source("webview-ui/agent-manager/SectionHeader.tsx")).toContain("<ColorMenuItems")
    expect(source("webview-ui/agent-manager/sortable-tab.tsx")).toContain("<ColorMenuItems")
  })

  it("keeps the sidebar color producer and consumer contract", () => {
    const tabs = source("webview-ui/src/context/local-tabs.tsx")

    expect(tabs).toContain("withSessionColor(prev, id, color)")
    expect(tabs).toContain('vscode.postMessage({ type: "setSessionColor", sessionId: id, color })')
    expect(tabs).toContain('vscode.postMessage({ type: "requestSessionColors" })')
    expect(tabs).toContain('message.type !== "sessionColorsLoaded"')
  })

  it("keeps the Agent Manager tab rendering and search wiring", () => {
    const rendering = source("webview-ui/agent-manager/tab-rendering.tsx")

    expect(rendering).toContain("sessionColor: (id: string) => string | undefined")
    expect(rendering).toContain("setSessionColor: (id: string, color: string | null) => void")
    expect(rendering).toContain("color={deps.sessionColor(s.id) ?? null}")
    expect(source("webview-ui/agent-manager/AgentManagerApp.tsx")).toContain(
      "color={(id) => registry.active().sessionColors()[id]}",
    )
    expect(source("webview-ui/agent-manager/SidebarSearchMenu.tsx")).toContain("colorCss(item.sessionColor ?? null)")
    expect(source("webview-ui/src/components/chat/SessionTab.tsx")).toContain('class="am-tab-accent"')
    expect(source("webview-ui/src/components/chat/SessionTabMenu.tsx")).toContain("{props.colorMenu}")
  })
})
