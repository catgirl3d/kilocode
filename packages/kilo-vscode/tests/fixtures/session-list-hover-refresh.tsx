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
  getState: () => ({ sidebarSessionTabIDs: ["ses-two"], sidebarActiveSessionTabID: "ses-two" }),
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
  ...mockSessionValue({ id: "ses-two" }),
  sessions,
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-two" sessionTags={null} failTags={false} noPadding>
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

function keys() {
  return [...root.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')].map(
    (node) => node.getAttribute("data-key")!,
  )
}

function activeIDs() {
  return keys().filter((id) => active(id) === "true")
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

// simulate live activity: a session.updated event changes one session's title and updatedAt
function activity(seq: number) {
  setSessions((prev) =>
    prev.map((entry) =>
      entry.id === "ses-one"
        ? {
            ...entry,
            title: `Alpha session ${seq}`,
            updatedAt: new Date(Date.parse(entry.updatedAt) + 5000).toISOString(),
          }
        : entry,
    ),
  )
}

// initial state: the current row is active even though it is not the first row
await settle()
assert.equal(active("ses-two"), "true", "the current row starts active (current is not the first row)")

// hovering a row moves the active highlight there
hover("ses-three")
await settle()
assert.equal(active("ses-three"), "true", "hovering moves the active row")
assert.equal(active("ses-two"), "false", "hovering clears the current row")

// a live data refresh updates the DOM without stealing the hovered highlight
activity(1)
await settle()
assert(root.textContent.includes("Alpha session 1"), "the live refresh rendered updated data")
assert.equal(active("ses-three"), "true", "a data refresh keeps the hovered row active")
assert.equal(active("ses-one"), "false", "a data refresh does not move the highlight to the first row")

// a filter change resets to the first result even when the previously active row survives
filter("session")
await settle()
item("ses-three")
const firstMatch = keys()[0]!
assert.notEqual(firstMatch, "ses-three", "premise: the surviving row is not the first result")
assert.equal(active(firstMatch), "true", "a filter change selects the first row even when the active row survives")

// filtering selects the first matching row, and clearing it resets to the first row
filter("Delta")
await settle()
assert.equal(active("ses-four"), "true", "filtering selects the first matching row")
filter("")
await settle()
await settle()
assert.equal(active("ses-one"), "true", "clearing the filter resets the highlight to the first row")

// keyboard navigation selects a deterministic row and survives a data refresh
root
  .querySelector<HTMLInputElement>('[data-slot="list-search"] input')
  ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
await settle()
assert.equal(active("ses-two"), "true", "ArrowDown moves the highlight to the second row")
assert.equal(active("ses-one"), "false", "ArrowDown clears the first row highlight")
assert.equal(activeIDs().length, 1, "exactly one row is highlighted after keyboard navigation")
activity(2)
await settle()
assert(root.textContent.includes("Alpha session 2"), "the second live refresh rendered updated data")
assert.equal(active("ses-two"), "true", "a data refresh keeps the keyboard-selected row active")

// removing the active row without changing the filter resets to the first row
setSessions((prev) => prev.filter((entry) => entry.id !== "ses-two"))
await settle()
assert.equal(root.querySelector('[data-slot="list-item"][data-key="ses-two"]'), null, "the removed row is unmounted")
assert.equal(active("ses-one"), "true", "removing the active row resets the highlight to the first row")

// leaving the list clears the active row; a later refresh falls back to the first row
hover("ses-one")
await settle()
item("ses-one").dispatchEvent(new MouseEvent("mouseleave"))
await settle()
assert.equal(
  root.querySelectorAll('[data-slot="list-item"][data-active="true"]').length,
  0,
  "leaving the list clears the active row",
)
activity(3)
await settle()
assert(root.textContent.includes("Alpha session 3"), "the third live refresh rendered updated data")
assert.equal(active("ses-one"), "true", "a refresh with no active row falls back to the first row")

dispose()
assert.equal(root.childNodes.length, 0, "disposing the tree removes the list")
