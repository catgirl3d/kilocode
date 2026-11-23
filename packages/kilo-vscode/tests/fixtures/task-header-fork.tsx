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
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  MessageEvent: window.MessageEvent,
  customElements: window.customElements,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")
const { PENDING_TAB_PREFIX } = await import("../../webview-ui/src/utils/local-tabs")

const now = new Date().toISOString()
const makeSession = (id: string, status: string, title: string) => ({
  ...mockSessionValue({ id, status }),
  currentSessionID: () => id,
  currentSession: () => ({ id, title, createdAt: now, updatedAt: now }),
  messages: () => [{ id: `${id}-message`, sessionID: id, role: "user", createdAt: now }],
  visibleMessages: () => [],
})

const local = makeSession("ses-home", "idle", "Local session")
const busy = makeSession("ses-busy", "busy", "Busy session")
const retry = makeSession("ses-retry", "retry", "Retry session")
const offline = makeSession("ses-offline", "offline", "Offline session")
const cloud = makeSession("cloud:preview", "idle", "Cloud preview")
const draft = makeSession(`${PENDING_TAB_PREFIX}fork`, "idle", "Unsaved draft")
const forked: string[] = []

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-home" sessionTags={null} sessionFavorites={null} noPadding>
      <div data-testid="local-header">
        <SessionContext.Provider value={local as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="busy-header">
        <SessionContext.Provider value={busy as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="retry-header">
        <SessionContext.Provider value={retry as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="offline-header">
        <SessionContext.Provider value={offline as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="cloud-header">
        <SessionContext.Provider value={cloud as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="draft-header">
        <SessionContext.Provider value={draft as never}>
          <TaskHeader onFork={(id) => forked.push(id)} />
        </SessionContext.Provider>
      </div>
      <div data-testid="plain-header">
        <SessionContext.Provider value={local as never}>
          <TaskHeader />
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
  assert.equal(button.getAttribute("aria-expanded"), "false", `${scope} header closes its More actions menu`)
}

function item(menu: HTMLElement, text: string) {
  return [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((entry) =>
    entry.textContent?.includes(text),
  )
}

function select(entry: HTMLElement) {
  entry.dispatchEvent(
    new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
  )
}

async function assertDisabled(scope: string) {
  const opened = await open(scope)
  const fork = item(opened.menu, "Fork Session")
  assert(fork, `${scope} header keeps the Fork Session row visible`)
  assert.equal(fork.hasAttribute("data-disabled"), true, `${scope} header disables the Fork Session row`)
  const count = forked.length
  select(fork)
  await settle()
  assert.equal(forked.length, count, `${scope} header does not call onFork from a disabled row`)
  await close(scope, opened.button)
}

try {
  await settle()

  const opened = await open("local-header")
  const fork = item(opened.menu, "Fork Session")
  assert(fork, "the local header exposes the translated Fork Session row")
  assert.equal(fork.textContent?.includes("agentManager.tab.forkSession"), false, "the row uses the translated label")
  assert.equal(fork.hasAttribute("data-disabled"), false, "an idle local session enables the Fork Session row")
  select(fork)
  await settle()
  assert.deepEqual(forked, ["ses-home"], "selecting Fork Session passes the current session id once")
  assert.equal(opened.button.getAttribute("aria-expanded"), "false", "the menu closes after selecting Fork Session")

  await assertDisabled("busy-header")
  await assertDisabled("retry-header")
  await assertDisabled("offline-header")
  await assertDisabled("cloud-header")
  await assertDisabled("draft-header")

  const plain = await open("plain-header")
  assert.equal(item(plain.menu, "Fork Session"), undefined, "a header without onFork has no Fork Session row")
  assert(item(plain.menu, "Copy session ID"), "a header without onFork keeps Copy session ID")
  await close("plain", plain.button)

  assert.deepEqual(errors, [], "the chat header fork scenario raises no window errors")
} finally {
  dispose()
  await window.happyDOM.close()
}
