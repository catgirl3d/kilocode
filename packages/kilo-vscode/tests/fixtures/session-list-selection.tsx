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
  { id: "ses-five", title: "Epsilon session", createdAt: now, updatedAt: now },
]

const [sessions, setSessions] = createSignal(items)
const removed: string[] = []
const opened: string[] = []
const session = {
  ...mockSessionValue({ id: "ses-one" }),
  sessions,
  deleteSession: (id: string) => {
    removed.push(id)
    setSessions((prev) => prev.filter((entry) => entry.id !== id))
  },
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-one" sessionTags={null} failTags={false} noPadding>
      <SessionContext.Provider value={session as never}>
        <section data-testid="history">
          <SessionList onSelectSession={(id) => opened.push(id)} />
        </section>
      </SessionContext.Provider>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function history() {
  const value = root.querySelector<HTMLElement>('[data-testid="history"]')
  assert(value, "history list is mounted")
  return value
}

function item(id: string) {
  return history().querySelector<HTMLButtonElement>(`[data-slot="list-item"][data-key="${id}"]`)
}

function toggle() {
  const value = history().querySelector<HTMLButtonElement>(".session-select-toggle")
  assert(value, "the select-mode toggle is mounted")
  return value
}

function bar() {
  return history().querySelector<HTMLElement>(".session-select-bar")
}

function count() {
  return history().querySelector<HTMLElement>(".session-select-count")?.textContent?.trim()
}

function barButtons() {
  return [...(bar()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
}

function check(id: string) {
  const row = item(id)?.closest(".session-row")
  assert(row, `row ${id} is mounted`)
  const box = row.querySelector<HTMLElement>(".session-select-check")
  assert(box, `row ${id} exposes a selection checkbox`)
  const input = box.querySelector<HTMLInputElement>('[data-slot="checkbox-checkbox-input"]')
  const label = box.querySelector<HTMLElement>('[data-slot="checkbox-checkbox-label"]')
  assert(input && label, `row ${id} checkbox has its input and label`)
  return { box, input, label }
}

function filter(value: string) {
  const input = history().querySelector<HTMLInputElement>('[data-slot="list-search"] input')
  assert(input, "history search input is mounted")
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return input
}

function dialog() {
  const value = document.querySelector<HTMLElement>('[role="dialog"]')
  assert(value, "the confirm dialog is mounted")
  return value
}

function dialogButtons() {
  return [...dialog().querySelectorAll<HTMLButtonElement>(".dialog-confirm-actions button")]
}

// default state: no selection affordances until the user opts in
assert.equal(toggle().textContent?.trim(), "Select", "the list starts with the translated select action")
assert.equal(
  history().querySelectorAll(".session-select-check").length,
  0,
  "checkboxes stay hidden until select mode is entered",
)
assert.equal(bar(), null, "the bulk action bar stays hidden until select mode is entered")

// enter select mode
toggle().click()
await settle()
assert.equal(history().querySelectorAll(".session-select-check").length, 5, "select mode shows a checkbox on every row")
assert.equal(count(), "Selected: 0", "select mode starts with an empty selection")
assert.equal(barButtons()[1]?.disabled, true, "delete stays disabled while nothing is selected")
assert.equal(check("ses-one").label.textContent, "Alpha session", "each checkbox is labelled with its session title")
assert.equal(
  history().querySelectorAll(".session-select-bar").length,
  1,
  "the list renders exactly one bulk action bar",
)
assert(
  history().querySelector('[data-slot="list-search-wrapper"] .session-select-bar'),
  "the bulk action bar lives in the list search area",
)
assert.equal(
  check("ses-one").box.parentElement,
  item("ses-one")!.parentElement,
  "the checkbox shares the session row with its button",
)
assert.equal(item("ses-one")!.contains(check("ses-one").box), false, "the checkbox stays outside the List button")

// a checkbox click selects its session
check("ses-one").label.click()
await settle()
assert.equal(check("ses-one").input.checked, true, "clicking a checkbox selects its session")
assert.equal(count(), "Selected: 1")
assert.equal(barButtons()[1]?.disabled, false, "delete enables once a session is selected")

// a row click toggles the selection instead of opening the session
item("ses-two")!.click()
await settle()
assert.equal(check("ses-two").input.checked, true, "a row click toggles selection in select mode")
assert.deepEqual(opened, [], "select mode does not open sessions")
assert.equal(count(), "Selected: 2")

// clicking a selected row clears it again
item("ses-two")!.click()
await settle()
assert.equal(check("ses-two").input.checked, false, "a second row click clears the selection")
assert.equal(count(), "Selected: 1")

// the selection survives search filtering
filter("Gamma")
await settle()
assert.equal(item("ses-one"), null, "the filter hides the selected session")
assert(item("ses-three"), "the filter keeps the matching session")
assert.equal(count(), "Selected: 1", "a hidden session stays selected")
filter("")
await settle()
assert.equal(check("ses-one").input.checked, true, "the restored row keeps its checkbox checked")

// select one more session, then leave select mode without deleting
check("ses-three").label.click()
await settle()
assert.equal(count(), "Selected: 2")
barButtons()[0]!.click()
await settle()
assert.equal(bar(), null, "cancel leaves select mode")
assert.equal(history().querySelectorAll(".session-select-check").length, 0, "cancel removes the checkboxes")
item("ses-two")!.click()
await settle()
assert.deepEqual(opened, ["ses-two"], "a normal row click opens the session again")

// bulk deletion asks for confirmation first
toggle().click()
await settle()
check("ses-one").label.click()
check("ses-two").label.click()
await settle()
assert.equal(count(), "Selected: 2")
barButtons()[1]!.click()
await settle()
assert.equal(dialogButtons().length, 2, "the confirm dialog offers cancel and delete")
assert(dialog().textContent?.includes("Delete sessions"), "the dialog names the bulk action")
assert(dialog().textContent?.includes("(2)"), "the dialog names how many sessions it will delete")

// cancelling keeps the selection and deletes nothing
dialogButtons()[0]!.click()
await settle()
assert.deepEqual(removed, [], "cancelling deletes nothing")
assert.equal(dialog().hasAttribute("data-closed"), true, "cancelling starts closing the dialog")
assert.equal(count(), "Selected: 2", "cancelling keeps the selection")

// confirming deletes every chosen session even when the filter hides one of them
filter("Beta")
await settle()
assert.equal(item("ses-one"), null, "the filter hides one of the chosen sessions")
assert.equal(count(), "Selected: 2", "the filter does not shrink the pending selection")
barButtons()[1]!.click()
await settle()
assert(dialog().textContent?.includes("(2)"), "the dialog still counts the hidden chosen session")
dialogButtons()[1]!.click()
await settle()
assert.deepEqual([...removed].sort(), ["ses-one", "ses-two"], "confirming deletes every chosen session")
filter("")
await settle()
assert.equal(item("ses-one"), null, "a deleted session leaves the list")
assert.equal(item("ses-two"), null, "every deleted session leaves the list")
assert(item("ses-three"), "an unselected session stays")
assert.equal(bar(), null, "confirming leaves select mode")
assert.equal(history().querySelectorAll(".session-select-check").length, 0, "confirming removes the checkboxes")

// a session that disappears while the confirmation is open drops out of the pending selection
removed.length = 0
toggle().click()
await settle()
check("ses-three").label.click()
check("ses-four").label.click()
await settle()
assert.equal(count(), "Selected: 2")
barButtons()[1]!.click()
await settle()
assert(dialog().textContent?.includes("(2)"), "the dialog starts with the full pending selection")
setSessions((prev) => prev.filter((entry) => entry.id !== "ses-four"))
await settle()
assert.equal(count(), "Selected: 1", "the toolbar drops the session removed while the dialog is open")
assert(dialog().textContent?.includes("(1)"), "the dialog counts only the remaining selection")
dialogButtons()[1]!.click()
await settle()
assert.deepEqual([...removed].sort(), ["ses-three"], "confirming deletes only the remaining chosen session")
assert.equal(item("ses-three"), null, "the deleted session leaves the list")
assert.equal(item("ses-four"), null, "the session removed while confirming stays gone")
assert(item("ses-five"), "an untouched session stays")
assert.equal(bar(), null, "confirming leaves select mode")

// confirming an emptied selection deletes nothing
removed.length = 0
toggle().click()
await settle()
check("ses-five").label.click()
await settle()
barButtons()[1]!.click()
await settle()
setSessions((prev) => prev.filter((entry) => entry.id !== "ses-five"))
await settle()
assert.equal(count(), "Selected: 0", "the toolbar shows an empty selection")
assert(dialog().textContent?.includes("(0)"), "a session removed while the dialog is open leaves the pending count")
dialogButtons()[1]!.click()
await settle()
assert.deepEqual(removed, [], "confirming an emptied selection deletes nothing")
assert.equal(bar(), null, "confirming leaves select mode")

dispose()
assert.equal(root.childNodes.length, 0, "disposing the tree removes the list")
