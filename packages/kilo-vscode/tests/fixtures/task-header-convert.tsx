/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const errors: unknown[] = []
window.addEventListener("error", (event) => {
  if (event instanceof window.ErrorEvent) errors.push(event.error)
})

const converted: string[] = []
const api = {
  postMessage: (_message: WebviewMessage) => {},
  getState: () => undefined,
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
  PointerEvent: window.PointerEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")
const { post } = await import("../../webview-ui/src/utils/webview-message")

const now = new Date().toISOString()

// A sub-agent viewer: the header reads only the session id, so the session info stays unloaded.
const viewer = (status: string) => ({
  ...mockSessionValue({ id: "ses-child", status }),
  currentSessionID: () => "ses-child",
  currentSession: () => undefined,
  messages: () => [{ id: "child-message", sessionID: "ses-child", role: "user", createdAt: now }],
  visibleMessages: () => [],
})
const idle = viewer("idle")
const busy = viewer("busy")
const local = {
  ...idle,
  currentSession: () => ({ id: "ses-child", title: "Local session", createdAt: now, updatedAt: now }),
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-child" sessionTags={null} sessionFavorites={null} noPadding>
      <div data-testid="convert-header">
        <SessionContext.Provider value={idle as never}>
          <TaskHeader readonly onConvert={(id) => converted.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="busy-header">
        <SessionContext.Provider value={busy as never}>
          <TaskHeader readonly onConvert={(id) => converted.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="plain-header">
        <SessionContext.Provider value={idle as never}>
          <TaskHeader readonly />
        </SessionContext.Provider>
      </div>
      <div data-testid="header">
        <SessionContext.Provider value={local as never}>
          <TaskHeader onConvert={(id) => converted.push(id)} />
        </SessionContext.Provider>
      </div>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

function trigger(scope: string) {
  return root.querySelector<HTMLElement>(`[data-testid="${scope}"] button[aria-label="More actions"]`)
}

const press = (node: HTMLElement, type: string) =>
  node.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: "mouse",
    }) as unknown as Event,
  )

async function open(scope: string) {
  const button = trigger(scope)
  assert(button, `${scope} header exposes the More actions trigger`)
  press(button, "pointerdown")
  await settle()
  assert.equal(button.getAttribute("aria-expanded"), "true", `${scope} header opens its More actions menu`)
  const id = button.getAttribute("aria-controls")
  assert(id, `${scope} header points at its own menu content`)
  const menu = document.getElementById(id)
  assert(menu, `${scope} header renders the More actions menu content`)
  return { button, menu: menu as HTMLElement }
}

async function close(scope: string, button: HTMLElement) {
  press(button, "pointerdown")
  await settle()
  // The harness keeps closed overlays mounted (no CSS for the exit animation),
  // so the closed state is read from the trigger rather than from the DOM.
  assert.equal(button.getAttribute("aria-expanded"), "false", `${scope} header closes its More actions menu`)
}

function menuItem(menu: HTMLElement, text: string) {
  return [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((entry) =>
    entry.textContent?.includes(text),
  )
}

function select(item: HTMLElement) {
  item.dispatchEvent(
    new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
  )
}

const CONVERT = "Convert to regular session"

try {
  await settle()

  // A read-only sub-agent viewer offers the convert action, and selecting it passes the sub-agent id.
  const viewerMenu = await open("convert-header")
  const convertItem = menuItem(viewerMenu.menu, CONVERT)
  assert(convertItem, "the read-only viewer menu exposes Convert to regular session")
  assert.equal(convertItem.hasAttribute("data-disabled"), false, "an idle sub-agent offers the convert action")
  select(convertItem)
  await settle()
  assert.deepEqual(converted, ["ses-child"], "the convert action passes the sub-agent session id to onConvert")
  assert.equal(viewerMenu.button.getAttribute("aria-expanded"), "false", "the menu closes after converting")

  // A running sub-agent disables the convert action, so selecting it does nothing.
  const busyMenu = await open("busy-header")
  const busyItem = menuItem(busyMenu.menu, CONVERT)
  assert(busyItem, "the busy viewer menu still lists Convert to regular session")
  assert.equal(busyItem.hasAttribute("data-disabled"), true, "a running sub-agent disables the convert action")
  select(busyItem)
  await settle()
  assert.deepEqual(converted, ["ses-child"], "a disabled convert action does not call onConvert")
  await close("busy", busyMenu.button)

  // A read-only header without onConvert keeps the More actions menu hidden.
  assert.equal(trigger("plain-header"), null, "a read-only header without onConvert hides the More actions menu")

  // The normal session menu never offers the convert action, and keeps Copy session ID.
  const localMenu = await open("header")
  assert.equal(menuItem(localMenu.menu, CONVERT), undefined, "the normal session menu has no convert action")
  assert(menuItem(localMenu.menu, "Copy session ID"), "the normal session menu keeps Copy session ID")
  await close("header", localMenu.button)

  // The compact setting is shared by every header, so the expanded checks run after the compact ones.
  post({
    type: "chatSettingsLoaded",
    settings: {
      shiftTabCyclesVariant: false,
      compactHeaderActions: false,
      browserAutomation: false,
      agentManagerBrowserOpenLinksIn: "external",
      workspaceTrusted: false,
    },
  })
  await settle()
  assert.equal(trigger("header"), null, "the expanded session header drops the compact More actions menu")

  // An expanded read-only sub-agent viewer still offers the convert action from its More actions trigger.
  const expandedMenu = await open("convert-header")
  const expandedItem = menuItem(expandedMenu.menu, CONVERT)
  assert(expandedItem, "the expanded read-only viewer menu exposes Convert to regular session")
  assert.equal(
    expandedItem.hasAttribute("data-disabled"),
    false,
    "the expanded viewer offers the convert action when idle",
  )
  await close("convert", expandedMenu.button)

  // An expanded read-only header without onConvert keeps the More actions menu hidden.
  assert.equal(
    trigger("plain-header"),
    null,
    "an expanded read-only header without onConvert hides the More actions menu",
  )

  assert.deepEqual(errors, [], "the convert scenario raises no window errors")
} finally {
  dispose()
  await window.happyDOM.close()
}
