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

const sent: WebviewMessage[] = []
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
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
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { ServerProvider } = await import("../../webview-ui/src/context/server")
const { ProviderProvider } = await import("../../webview-ui/src/context/provider")
const { ConfigContext } = await import("../../webview-ui/src/context/config")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { SessionTagsProvider } = await import("../../webview-ui/src/context/session-tags")
const { NotificationsProvider } = await import("../../webview-ui/src/context/notifications")
const { SessionProvider, useSession } = await import("../../webview-ui/src/context/session")
const { MemoryProvider } = await import("../../webview-ui/src/context/memory")
const { TranscriptSearchProvider } = await import("../../webview-ui/src/context/transcript-search")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")
const { post } = await import("../../webview-ui/src/utils/webview-message")

// No chat.compactHeaderActions setting: TaskHeader defaults it to true, so the actions fold into the "..." menu.
const config = {
  config: () => ({}),
  globalConfig: () => ({}),
  globalDraft: () => ({}),
  projectConfig: () => ({}),
  collections: () => ({}),
  settings: () => ({}),
  shortcuts: () => ({ bindings: {}, selection: false }),
  features: () => ({ indexing: false, sandboxControls: false, backgroundSubagents: false }),
  loading: () => false,
  isDirty: () => false,
  saving: () => false,
  saveError: () => null,
  updateConfig: () => {},
  updateGlobalConfig: () => {},
  updateProjectConfig: () => {},
  updateSetting: () => {},
  applySetting: () => {},
  saveConfig: () => {},
  discardConfig: () => {},
}
const language = {
  locale: () => "en",
  setLocale: () => {},
  userOverride: () => "",
  t: (key: string) => key,
}

const ref = { value: undefined as ReturnType<typeof useSession> | undefined }
const Probe = () => {
  ref.value = useSession()
  return null
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <VSCodeProvider>
      <ServerProvider>
        <ProviderProvider>
          <ConfigContext.Provider value={config as never}>
            <LanguageContext.Provider value={language as never}>
              <SessionTagsProvider>
                <NotificationsProvider>
                  <SessionProvider>
                    <MemoryProvider>
                      <TranscriptSearchProvider>
                        <DialogProvider>
                          <Probe />
                          <div data-testid="header">
                            <TaskHeader />
                          </div>
                        </DialogProvider>
                      </TranscriptSearchProvider>
                    </MemoryProvider>
                  </SessionProvider>
                </NotificationsProvider>
              </SessionTagsProvider>
            </LanguageContext.Provider>
          </ConfigContext.Provider>
        </ProviderProvider>
      </ServerProvider>
    </VSCodeProvider>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

const emit = async (data: { type: string; [key: string]: unknown }) => {
  post(structuredClone(data) as never)
  await settle()
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

// The identity translator turns the trigger's aria-label into its i18n key.
function trigger() {
  return root.querySelector<HTMLElement>('[data-testid="header"] button[aria-label="prompt.action.more"]')
}

async function open() {
  const button = trigger()
  assert(button, "the header exposes the More actions trigger")
  press(button, "pointerdown")
  await settle()
  assert.equal(button.getAttribute("aria-expanded"), "true", "the header opens its More actions menu")
  const id = button.getAttribute("aria-controls")
  assert(id, "the trigger points at its menu content")
  const menu = document.getElementById(id)
  assert(menu, "the header renders the More actions menu content")
  return { button, menu: menu as HTMLElement }
}

function items(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')]
}

function label(item: HTMLElement) {
  return item.querySelector('[data-slot="dropdown-menu-item-label"]')?.textContent?.trim()
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

function action(node: HTMLElement, text: string) {
  const button = [...node.querySelectorAll<HTMLButtonElement>(".dialog-confirm-actions button")].find(
    (entry) => entry.textContent?.trim() === text,
  )
  assert(button, `the confirmation dialog offers ${text}`)
  return button
}

async function ask() {
  const local = await open()
  const item = items(local.menu).find((entry) => label(entry) === "session.delete.title")
  assert(item, "the More actions menu exposes Delete session")
  select(item)
  await settle()
  assert.equal(local.button.getAttribute("aria-expanded"), "false", "the menu closes after choosing Delete session")
  return dialog()
}

const title = () => root.querySelector('[data-slot="task-header-title-label"]')?.textContent?.trim()
const deletes = () => sent.filter((message) => message.type === "deleteSession")

const id = "ses-home"
const other = "ses-other"
const now = new Date().toISOString()

try {
  await settle()

  // The host reports a connected backend; deleteSession is a silent no-op while disconnected.
  await emit({ type: "ready", serverInfo: { port: 1 } })
  await emit({
    type: "sessionsLoaded",
    sessions: [
      { id, title: "Home session", createdAt: now, updatedAt: now },
      { id: other, title: "Other session", createdAt: now, updatedAt: now },
    ],
  })
  const session = ref.value
  assert(session, "the probe captured the real session context")

  // No host message makes a session current in SessionProvider; App calls selectSession for it.
  session.selectSession(id)
  await settle()
  assert(
    sent.some((message) => message.type === "loadMessages" && message.sessionID === id),
    "selecting a session asks the host for its messages",
  )
  await emit({
    type: "messagesLoaded",
    sessionID: id,
    mode: "replace",
    messages: [{ id: "home-message", sessionID: id, role: "user", createdAt: now }],
  })
  assert.equal(session.currentSessionID(), id, "the loaded session is current")
  assert.equal(title(), "Home session", "the header renders the current session title")

  // 1. Menu contract: the delete row is appended after the existing actions, in order.
  const menu = await open()
  assert.deepEqual(
    items(menu.menu).map(label),
    [
      "chat.search.toggle",
      "command.session.compact",
      "command.session.shake",
      "session.action.copyId",
      "chat.action.disconnectCli",
      "session.delete.title",
    ],
    "the More actions menu lists exactly the session actions in order, with Delete session last",
  )
  const row = items(menu.menu).find((entry) => label(entry) === "session.delete.title")
  assert.equal(row?.hasAttribute("data-disabled"), false, "a local session offers the delete action")
  press(menu.button, "pointerdown")
  await settle()
  assert.equal(menu.button.getAttribute("aria-expanded"), "false", "the More actions menu closes")

  // 2. Cancel path: nothing reaches the host and the session stays current.
  const first = await ask()
  assert(first.textContent?.includes("session.delete.confirm"), "the dialog asks to confirm the deletion")
  action(first, "common.cancel").click()
  await settle()
  assert.deepEqual(deletes(), [], "cancelling posts no deleteSession message")
  assert.equal(session.currentSessionID(), id, "cancelling keeps the session current")
  assert.equal(title(), "Home session", "cancelling keeps the header on the session")
  assert(
    session.sessions().some((entry) => entry.id === id),
    "cancelling keeps the session in the context's session list",
  )

  // 3. Confirm path: the real context posts exactly one deleteSession for the session.
  const second = await ask()
  action(second, "session.delete.button").click()
  await settle()
  assert.deepEqual(
    deletes(),
    [{ type: "deleteSession", sessionID: id }],
    "confirming posts exactly one deleteSession for the current session",
  )
  assert.equal(
    second.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
    true,
    "confirming closes the dialog",
  )
  // The context drops the session from its list optimistically but keeps it current until the host confirms.
  assert.equal(session.currentSessionID(), id, "the session stays current until the host confirms the deletion")
  assert.deepEqual(
    session.sessions().map((entry) => entry.id),
    [other],
    "the context optimistically drops only the deleted session from its list",
  )
  assert.equal(title(), "command.session.new", "the header no longer names the deleted session")

  // 4. Host round-trip: sessionDeleted clears the current session and leaves the unrelated one.
  await emit({ type: "sessionDeleted", sessionID: id })
  assert.equal(session.currentSessionID(), undefined, "the host deletion clears the current session")
  assert.equal(session.draftSessionID(), undefined, "the host deletion clears the session draft")
  assert.equal(session.messages().length, 0, "the deleted session's messages are gone")
  assert.equal(
    root.querySelector('[data-testid="header"] [data-component="task-header"]'),
    null,
    "the header no longer renders the deleted session",
  )
  assert.deepEqual(
    session.sessions().map((entry) => entry.id),
    [other],
    "the unrelated session survives the deletion round-trip",
  )
  assert.equal(deletes().length, 1, "the round-trip posts no further deleteSession message")

  // 5. No window errors during the scenario.
  assert.deepEqual(errors, [], "the delete regression scenario raises no window errors")
} finally {
  dispose()
  await window.happyDOM.cancelAsync()
  await window.happyDOM.close()
}

process.exit(0)
