/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"

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
const { StoryProviders } = await import("../../webview-ui/src/stories/StoryProviders")
const { List } = await import("@kilocode/kilo-ui/list")

type Row = { id: string; title: string }

const [items, setItems] = createSignal<Row[]>([
  { id: "one", title: "Item one" },
  { id: "two", title: "Item two" },
  { id: "three", title: "Item three" },
])
let selected: string | undefined

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders noPadding>
      <List<Row>
        items={items()}
        key={(x) => x.id}
        noInitialSelection
        emptyMessage="No items"
        loadingMessage="Loading"
        onSelect={(x) => {
          selected = x?.id
        }}
      >
        {(item) => <span data-slot="list-item-title">{item.title}</span>}
      </List>
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

function noneActive() {
  return root.querySelectorAll('[data-slot="list-item"][data-active="true"]').length
}

function refresh(seq: number) {
  setItems((prev) =>
    prev.map((entry) => (entry.id === "one" ? { ...entry, title: `Item one live ${seq}` } : entry)),
  )
}

await settle()
assert.equal(noneActive(), 0, "no row starts active")

item("one").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
assert.equal(selected, "one", "Enter selects the first row when nothing is active")
selected = undefined

refresh(1)
await settle()
assert(root.textContent.includes("Item one live 1"), "the live refresh rendered updated data")
assert.equal(noneActive(), 0, "a refresh keeps no row active")

item("one").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
await settle()
assert.equal(active("one"), "true", "ArrowDown activates the first row when nothing is active")

refresh(2)
await settle()
assert(root.textContent.includes("Item one live 2"), "the second live refresh rendered updated data")
assert.equal(active("one"), "true", "a refresh keeps the manually activated row")

dispose()
assert.equal(root.childNodes.length, 0, "disposing the tree removes the list")
