/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"
import { post } from "../../webview-ui/src/utils/webview-message"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const errors: unknown[] = []
window.addEventListener("error", (event) => {
  if (event instanceof window.ErrorEvent) errors.push(event.error)
})

const sent: WebviewMessage[] = []
const attempts: string[] = []
let failCopy = false
const dispatch = (data: ExtensionMessage) => post(data)
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
    if (message.type !== "copyToClipboard") return
    attempts.push(message.text)
    dispatch(
      failCopy
        ? { type: "clipboardWriteResult", id: message.id, ok: false, error: "denied" }
        : { type: "clipboardWriteResult", id: message.id, ok: true },
    )
  },
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
const { PENDING_TAB_PREFIX } = await import("../../webview-ui/src/utils/local-tabs")

const now = new Date().toISOString()
const base = mockSessionValue({ id: "ses-home" })
const session = {
  ...base,
  currentSessionID: () => "ses-home",
  currentSession: () => ({ id: "ses-home", title: "Copy ID session", createdAt: now, updatedAt: now }),
  messages: () => [{ id: "home-message", sessionID: "ses-home", role: "user", createdAt: now }],
  visibleMessages: () => [],
}
const cloudKey = "cloud:preview"
const cloud = {
  ...session,
  currentSessionID: () => cloudKey,
  currentSession: () => ({ id: cloudKey, title: "Cloud preview", createdAt: now, updatedAt: now }),
}
const draftKey = `${PENDING_TAB_PREFIX}copy`
const draft = {
  ...session,
  currentSessionID: () => draftKey,
  currentSession: () => ({ id: draftKey, title: "Unsaved draft", createdAt: now, updatedAt: now }),
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-home" sessionTags={null} sessionFavorites={null} noPadding>
      <SessionContext.Provider value={session as never}>
        <div data-testid="header">
          <TaskHeader />
        </div>
        <div data-testid="readonly-header">
          <TaskHeader readonly />
        </div>
        <div data-testid="cloud-header">
          <SessionContext.Provider value={cloud as never}>
            <TaskHeader />
          </SessionContext.Provider>
        </div>
        <div data-testid="draft-header">
          <SessionContext.Provider value={draft as never}>
            <TaskHeader />
          </SessionContext.Provider>
        </div>
      </SessionContext.Provider>
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

function copyItem(menu: HTMLElement) {
  const item = [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((entry) =>
    entry.textContent?.includes("Copy session ID"),
  )
  assert(item, "the More actions menu exposes Copy session ID")
  return item
}

function select(item: HTMLElement) {
  item.dispatchEvent(
    new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
  )
}

try {
  await settle()

  // A local session copies its real session id and stays silent on success.
  const local = await open("header")
  const localItem = copyItem(local.menu)
  assert.equal(
    localItem.textContent?.includes("session.action.copyId"),
    false,
    "the copy row shows the translated label instead of the raw key",
  )
  assert.equal(localItem.hasAttribute("data-disabled"), false, "a local session offers the copy action")
  select(localItem)
  await settle()
  assert.deepEqual(attempts, ["ses-home"], "the copy action writes the current session id to the clipboard")
  assert.equal(local.button.getAttribute("aria-expanded"), "false", "the menu closes after the copy action")
  assert.equal(document.querySelector('[data-component="toast"]'), null, "a successful copy stays silent")

  // A cloud preview carries only a synthetic key, and an unsaved draft has no id yet.
  const cloudMenu = await open("cloud-header")
  assert.equal(copyItem(cloudMenu.menu).hasAttribute("data-disabled"), true, "a cloud preview disables the copy action")
  await close("cloud", cloudMenu.button)

  const draftMenu = await open("draft-header")
  assert.equal(
    copyItem(draftMenu.menu).hasAttribute("data-disabled"),
    true,
    "an unsaved draft disables the copy action",
  )
  await close("draft", draftMenu.button)
  assert.deepEqual(attempts, ["ses-home"], "disabled copy rows do not write to the clipboard")

  // Read-only sub-agent viewers keep the session actions folded away entirely.
  assert.equal(trigger("readonly-header"), null, "a read-only header hides the More actions menu")

  // A failed clipboard write surfaces an error instead of failing silently.
  failCopy = true
  const retry = await open("header")
  select(copyItem(retry.menu))
  await settle()
  const titles = [...document.querySelectorAll<HTMLElement>('[data-component="toast"] [data-slot="toast-title"]')]
  assert.equal(
    titles.at(-1)?.textContent?.trim(),
    "Could not copy the session ID.",
    "a failed clipboard write shows an error toast",
  )
  assert.deepEqual(attempts, ["ses-home", "ses-home"], "the failed attempt still targets the session id")
  assert.deepEqual(errors, [], "the copy scenario raises no window errors")

  const writes = sent.filter((message) => message.type === "copyToClipboard")
  assert.equal(writes.length, 2, "only the two real selections reach the clipboard bridge")
} finally {
  failCopy = false
  dispose()
  await window.happyDOM.close()
}
