/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const errors: unknown[] = []
window.addEventListener("error", (event) => {
  if (event instanceof window.ErrorEvent) errors.push(event.error)
})

// The prompt focus requests that reach the window, by their event detail.
const prompts: unknown[] = []
window.addEventListener("focusPrompt", (event) => {
  prompts.push(event instanceof window.CustomEvent ? event.detail : undefined)
})

const api = {
  postMessage: () => {},
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

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { WorktreeModeProvider } = await import("../../webview-ui/src/context/worktree-mode")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")
const { PENDING_TAB_PREFIX } = await import("../../webview-ui/src/utils/local-tabs")

const now = new Date().toISOString()
const home = { id: "ses-home", title: "Home session", createdAt: now, updatedAt: now }
const [current, setCurrent] = createSignal(home)
const removed: string[] = []
const base = mockSessionValue({ id: "ses-home" })
const session = {
  ...base,
  currentSessionID: () => current().id,
  currentSession: current,
  messages: () => [{ id: "home-message", sessionID: "ses-home", role: "user", createdAt: now }],
  visibleMessages: () => [],
  deleteSession: (id: string) => removed.push(id),
}
const cloudKey = "cloud:preview"
const cloud = {
  ...session,
  currentSessionID: () => cloudKey,
  currentSession: () => ({ id: cloudKey, title: "Cloud preview", createdAt: now, updatedAt: now }),
}
const draftKey = `${PENDING_TAB_PREFIX}delete`
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
        <div data-testid="worktree-header">
          <WorktreeModeProvider>
            <TaskHeader />
          </WorktreeModeProvider>
        </div>
      </SessionContext.Provider>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((done) => requestAnimationFrame(() => done(undefined)))
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

function find(menu: HTMLElement, label: string) {
  return [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((entry) =>
    entry.textContent?.includes(label),
  )
}

function deleteItem(menu: HTMLElement) {
  const item = find(menu, "Delete session")
  assert(item, "the More actions menu exposes Delete session")
  return item
}

function select(item: HTMLElement) {
  item.dispatchEvent(
    new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
  )
}

// The confirm dialog that is still open; a cancelled one stays mounted until its close timer runs.
function dialog() {
  const value = [...document.querySelectorAll<HTMLElement>('[data-component="dialog"]')].find(
    (entry) => !entry.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
  )
  assert(value, "the delete confirmation dialog is open")
  return value
}

function action(node: HTMLElement, label: string) {
  const button = [...node.querySelectorAll<HTMLButtonElement>(".dialog-confirm-actions button")].find(
    (entry) => entry.textContent?.trim() === label,
  )
  assert(button, `the confirmation dialog offers ${label}`)
  return button
}

async function ask() {
  prompts.length = 0
  const local = await open("header")
  select(deleteItem(local.menu))
  await settle()
  assert.equal(local.button.getAttribute("aria-expanded"), "false", "the menu closes after choosing Delete session")
  const value = dialog()
  assert.deepEqual(prompts, [], "opening the dialog sends no prompt focus request")
  return value
}

try {
  await settle()

  // A local session offers deletion; a cloud preview and an unsaved draft have no real session to delete.
  const local = await open("header")
  const item = deleteItem(local.menu)
  assert.equal(item.textContent?.includes("session.delete.title"), false, "the delete row shows the translated label")
  assert.equal(item.hasAttribute("data-disabled"), false, "a local session offers the delete action")
  await close("local", local.button)

  const cloudMenu = await open("cloud-header")
  assert.equal(deleteItem(cloudMenu.menu).hasAttribute("data-disabled"), true, "a cloud preview disables deletion")
  await close("cloud", cloudMenu.button)

  const draftMenu = await open("draft-header")
  assert.equal(deleteItem(draftMenu.menu).hasAttribute("data-disabled"), true, "an unsaved draft disables deletion")
  await close("draft", draftMenu.button)

  // Agent Manager headers expose deletion for real local sessions, just like the sidebar header.
  const worktreeMenu = await open("worktree-header")
  assert(find(worktreeMenu.menu, "Copy session ID"), "the Agent Manager header still renders its other actions")
  assert.equal(
    deleteItem(worktreeMenu.menu).hasAttribute("data-disabled"),
    false,
    "the Agent Manager header enables deletion for a real local session",
  )
  await close("worktree", worktreeMenu.button)

  // Choosing the action asks for confirmation; cancelling deletes nothing.
  const first = await ask()
  assert(first.textContent?.includes('Delete session "Home session"?'), "the dialog names the session it deletes")
  action(first, "Cancel").click()
  await settle()
  assert.deepEqual(removed, [], "cancelling deletes nothing")
  assert.equal(
    first.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
    true,
    "cancelling starts closing the dialog",
  )
  assert.deepEqual(prompts, [{ restore: true }], "cancelling returns focus to the prompt")

  // Confirming deletes the current session once.
  const second = await ask()
  action(second, "Delete session").click()
  await settle()
  assert.deepEqual(removed, ["ses-home"], "confirming deletes the current session")
  assert.equal(
    second.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
    true,
    "confirming closes the dialog",
  )
  assert.deepEqual(prompts, [{ restore: true }], "confirming returns focus to the prompt")

  // The dialog keeps the session it was opened for when the current session changes meanwhile.
  const third = await ask()
  setCurrent({ id: "ses-next", title: "Next session", createdAt: now, updatedAt: now })
  await settle()
  assert(third.textContent?.includes('Delete session "Home session"?'), "the dialog keeps naming its own session")
  assert.equal(third.textContent?.includes("Next session"), false, "the dialog ignores the newly current session")
  action(third, "Delete session").click()
  await settle()
  assert.deepEqual(removed, ["ses-home", "ses-home"], "confirming deletes the session the dialog was opened for")
  setCurrent(home)
  await settle()

  // Escape closes the dialog without deleting and also returns focus to the prompt.
  const fourth = await ask()
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await settle()
  assert.equal(fourth.querySelector('[role="dialog"]')?.hasAttribute("data-closed"), true, "Escape closes the dialog")
  assert.deepEqual(removed, ["ses-home", "ses-home"], "Escape deletes nothing")
  assert.deepEqual(prompts, [{ restore: true }], "Escape returns focus to the prompt")

  assert.deepEqual(errors, [], "the delete scenario raises no window errors")
} finally {
  dispose()
  await window.happyDOM.close()
}
