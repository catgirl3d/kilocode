/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"
import type { SessionContextValue } from "../../webview-ui/src/context/session-types"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })
const sent: WebviewMessage[] = []
const api = {
  postMessage: (msg: WebviewMessage) => sent.push(msg),
  getState: () => undefined,
  setState: () => {},
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  customElements: window.customElements,
  Event: window.Event,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})
Object.assign(window, { KILO_AGENT_MANAGER_INTRO_DISMISSED: true })

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { SessionTagsProvider } = await import("../../webview-ui/src/context/session-tags")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { createIntro } = await import("../../webview-ui/agent-manager/intro/AgentManagerIntro")
const { createSidebarCollapse } = await import("../../webview-ui/agent-manager/sidebar-collapse")
const { createChatSessionSelector, openLocalSession } = await import("../../webview-ui/agent-manager/selection-actions")

const [current, setCurrent] = createSignal<string | undefined>("ses-old")
const [selection, setSelection] = createSignal<string | null>("local")
const events: string[] = []
const recent = {
  id: "ses-recent",
  title: "Recent session",
  parentID: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const { mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const session = {
  ...mockSessionValue({ id: "ses-old" }),
  currentSessionID: current,
  sessions: () => [recent],
  selectSession: (id: string) => {
    events.push(`session:${id}`)
    setCurrent(id)
  },
} as unknown as SessionContextValue
const language = {
  locale: () => "en" as const,
  setLocale: () => {},
  userOverride: () => "" as const,
  t: (key: string) => key,
}
const side = createSidebarCollapse({ postMessage: (msg) => sent.push(msg) }, { initial: true })
const select = createChatSessionSelector({
  addSessionToCurrentWorktree: () => false,
  localSessionIDs: () => [],
  selection,
  setSelection: (id) => {
    events.push(`selection:${id}`)
    setSelection(id)
  },
  selectSession: session.selectSession,
  requestChatFocus: () => events.push("focus"),
  worktreeSessionIds: () => new Set(),
  managedSessions: () => [],
  selectWorktree: (id) => events.push(`worktree:${id}`),
  setReviewActive: (active) => events.push(`review:${active}`),
  openLocally: (id) =>
    openLocalSession({
      id,
      sessions: session.sessions(),
      saveTabMemory: () => events.push("save"),
      activePendingId: () => undefined,
      currentSessionID: session.currentSessionID,
      placeLocal: (sid, pending, active) => events.push(`place:${sid}:${pending}:${active}`),
      setSelection: (sid) => {
        events.push(`selection:${sid}`)
        setSelection(sid)
      },
      setReviewActive: (active) => events.push(`review:${active}`),
      selectSession: session.selectSession,
      requestChatFocus: () => events.push("focus"),
      post: (msg) => api.postMessage(msg),
    }),
})

const Probe = () =>
  createIntro({
    base: () => "main",
    git: () => true,
    onCreateWorktree: () => {},
    onSelectSession: select,
    onShowHistory: () => {},
    reveal: () => {},
    focus: () => {},
  }).render()
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <VSCodeProvider>
      <LanguageContext.Provider value={language}>
        <SessionTagsProvider>
          <SessionContext.Provider value={session}>
            <Probe />
          </SessionContext.Provider>
        </SessionTagsProvider>
      </LanguageContext.Provider>
    </VSCodeProvider>
  ),
  root,
)

const button = root.querySelector<HTMLButtonElement>(".recent-session-item")
assert.ok(button, "welcome screen should render the recent session")
button.click()
assert.equal(current(), "ses-recent")
assert.equal(side.collapsed(), true)
assert.deepEqual(
  sent.filter((msg) => msg.type === "agentManager.setSidebarCollapsed"),
  [],
)
assert.deepEqual(
  sent.filter((msg) => msg.type === "agentManager.openLocally"),
  [{ type: "agentManager.openLocally", sessionId: "ses-recent" }],
)
assert.deepEqual(events, [
  "save",
  "place:ses-recent:undefined:ses-old",
  "selection:local",
  "review:false",
  "session:ses-recent",
  "focus",
])
dispose()
root.remove()
