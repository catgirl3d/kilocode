/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { SessionInfo } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const api = {
  postMessage: () => {},
  getState: () => ({ sidebarSessionTabIDs: ["ses-one"], sidebarActiveSessionTabID: "ses-one" }),
  setState: () => {},
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  customElements: window.customElements,
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const SessionList = (await import("../../webview-ui/src/components/history/SessionList")).default

const now = new Date().toISOString()
const items: SessionInfo[] = [
  { id: "ses-one", title: "Alpha session", createdAt: now, updatedAt: now },
  { id: "ses-two", title: "Beta session", createdAt: now, updatedAt: now },
  { id: "ses-three", title: "Gamma session", createdAt: now, updatedAt: now },
  { id: "ses-four", title: "Delta session", createdAt: now, updatedAt: now },
]

const [sessions, setSessions] = createSignal(items)
const session = {
  ...mockSessionValue({ id: "ses-one" }),
  sessions,
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-one" sessionTags={null} failTags={false} noPadding>
      <SessionContext.Provider value={session as never}>
        <section data-testid="history">
          <SessionList onSelectSession={() => {}} />
        </section>
      </SessionContext.Provider>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function item(id: string) {
  const value = root.querySelector<HTMLButtonElement>(`[data-slot="list-item"][data-key="${id}"]`)
  assert(value, `row ${id} is mounted`)
  return value
}

function active(id: string) {
  return item(id).getAttribute("data-active")
}

function hover(id: string) {
  item(id).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 5 }))
}

function filter(value: string) {
  const input = root.querySelector<HTMLInputElement>('[data-slot="list-search"] input')
  assert(input, "history search input is mounted")
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

// simulate live activity: a session.updated event bumps one session's updatedAt
function activity() {
  setSessions((prev) =>
    prev.map((entry) =>
      entry.id === "ses-one"
        ? { ...entry, updatedAt: new Date(Date.parse(entry.updatedAt) + 5000).toISOString() }
        : entry,
    ),
  )
}

// initial state: the first row is active
await settle()
assert.equal(active("ses-one"), "true", "the list starts with the first row active")

// hovering a row moves the active highlight there
hover("ses-three")
await settle()
assert.equal(active("ses-three"), "true", "hovering moves the active row")
assert.equal(active("ses-one"), "false", "hovering clears the first row")

// a live data refresh (session activity) must not steal the highlight
activity()
await settle()
assert.equal(active("ses-three"), "true", "a data refresh keeps the hovered row active")
assert.equal(active("ses-one"), "false", "a data refresh does not move the highlight to the first row")

// a filter change still selects the first matching row (upstream behavior)
filter("Delta")
await settle()
assert.equal(active("ses-four"), "true", "filtering selects the first matching row")

// keyboard navigation is preserved across a data refresh too
filter("")
await settle()
await settle()
root
  .querySelector<HTMLInputElement>('[data-slot="list-search"] input')
  ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
await settle()
const afterArrow = ["ses-one", "ses-two", "ses-three", "ses-four"].find((id) => active(id) === "true")
assert(afterArrow, "arrow navigation keeps an active row")
activity()
await settle()
assert.equal(active(afterArrow), "true", "a data refresh keeps the keyboard-selected row active")

dispose()
assert.equal(root.childNodes.length, 0, "disposing the tree removes the list")
