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
// Real webview state: the clear dialogs remember their last confirmed keep-turns in it.
let saved: unknown
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
  },
  getState: () => saved,
  setState: (next: unknown) => {
    saved = next
  },
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
const { I18nProvider } = await import("@kilocode/kilo-ui/context")
const { Toast } = await import("@kilocode/kilo-ui/toast")
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
                          <I18nProvider
                            value={
                              {
                                locale: () => "en",
                                t: (key: string) => key,
                                plural: (key: string) => key,
                              } as never
                            }
                          >
                            <Probe />
                            <div data-testid="header">
                              <TaskHeader />
                            </div>
                            <Toast.Region />
                          </I18nProvider>
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
  assert(value, "the confirmation dialog is open")
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
const toasts = (variant: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-component="toast"]')].filter(
    (node) => node.getAttribute("data-variant") === variant,
  )

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

  // The reasoning action opens a per-session preview dialog and never applies
  // a stale or cancelled preview.
  const reasoningMenu = await open()
  const reasoningItem = items(reasoningMenu.menu).find((entry) => label(entry) === "command.session.reasoningClear")
  assert(reasoningItem, "the More actions menu exposes Clear old reasoning")
  select(reasoningItem)
  await settle()
  const reasoningDialog = dialog()
  const firstPreview = sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)
  assert(firstPreview, "opening the reasoning dialog requests a preview")
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: id,
    requestID: firstPreview.requestID,
    turns: 2,
    parts: 3,
    tokens: 88,
    unsupported: 0,
    token: "token-1",
  })
  const field = reasoningDialog.querySelector<HTMLInputElement>('input[type="number"]')
  assert(field, "the reasoning dialog exposes the keep-turns field")
  field.value = ""
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()
  assert.equal(
    action(reasoningDialog, "command.session.reasoningClear.button").disabled,
    true,
    "empty keep turns cannot apply",
  )
  field.value = "5"
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()
  assert.equal(
    action(reasoningDialog, "command.session.reasoningClear.button").disabled,
    true,
    "changing keep turns disables apply until the preview completes",
  )
  // Wait for the 300ms reasoning preview debounce before settling.
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()
  const previews = sent.filter((message) => message.type === "sessionReasoningClearPreview")
  assert.equal(previews.length, 2, "changing keep turns requests a fresh preview")
  const secondPreview = previews.at(-1)!
  const numbers = () =>
    [...reasoningDialog.querySelectorAll<HTMLElement>('[data-slot="reasoning-clear-preview"] strong')].map((node) =>
      node.textContent?.trim(),
    )
  const card = () => reasoningDialog.querySelector<HTMLElement>('[data-slot="reasoning-clear-preview"]')
  assert.deepEqual(numbers(), ["2", "3", "88"], "the previous numbers stay visible while the new preview loads")
  assert.equal(card()?.hasAttribute("data-stale"), true, "the previous numbers are dimmed while the new preview loads")
  assert.equal(
    reasoningDialog.querySelectorAll('[data-slot="reasoning-clear-status"]').length,
    0,
    "no loading line is shown while the previous numbers are visible",
  )
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: id,
    requestID: secondPreview.requestID,
    turns: 1,
    parts: 1,
    tokens: 20,
    unsupported: 0,
    token: "token-2",
  })
  assert.deepEqual(numbers(), ["1", "1", "20"], "the new preview replaces the previous numbers")
  assert.equal(card()?.hasAttribute("data-stale"), false, "the new preview is not dimmed")
  action(reasoningDialog, "command.session.reasoningClear.button").click()
  await settle()
  const applies = () => sent.filter((message) => message.type === "sessionReasoningClear")
  const apply = applies().at(-1)
  assert(apply, "confirming reasoning clear posts an apply request")
  assert.deepEqual(apply, {
    type: "sessionReasoningClear",
    sessionID: id,
    requestID: apply.requestID,
    keepTurns: 5,
    token: "token-2",
  })
  assert.equal(field.disabled, true, "the keep-turns field is disabled while reasoning clear applies")
  const closeButton = reasoningDialog.querySelector<HTMLButtonElement>('[data-slot="dialog-close-button"]')
  assert(closeButton, "the reasoning dialog exposes a close button")
  assert.equal(closeButton.disabled, true, "the close button is disabled while reasoning clear applies")
  field.value = "6"
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()
  assert.equal(
    sent.filter((message) => message.type === "sessionReasoningClearPreview").length,
    2,
    "editing during apply does not request another preview",
  )
  await emit({
    type: "sessionReasoningCleared",
    sessionID: id,
    requestID: apply.requestID,
    parts: 1,
    turns: 1,
    tokens: 20,
  })
  assert.equal(
    reasoningDialog.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
    true,
    "a successful reasoning clear closes the dialog",
  )
  assert.equal(
    toasts("success").some((node) => node.textContent?.includes("command.session.reasoningClear.success")),
    true,
    "a current-session reasoning clear shows a success toast",
  )

  const successToastCount = toasts("success").length

  const cancelledMenu = await open()
  const cancelledItem = items(cancelledMenu.menu).find((entry) => label(entry) === "command.session.reasoningClear")
  assert(cancelledItem)
  select(cancelledItem)
  await settle()
  const cancelledDialog = dialog()
  const mounted = sent.filter((message) => message.type === "sessionReasoningClearPreview").length
  const cancelledField = cancelledDialog.querySelector<HTMLInputElement>('input[type="number"]')
  assert(cancelledField, "the cancelled reasoning dialog exposes the keep-turns field")
  assert.equal(cancelledField.value, "5", "the reasoning dialog starts from the last confirmed keep-turns")
  assert.equal(
    sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)?.keepTurns,
    5,
    "the reasoning dialog previews the remembered keep-turns on open",
  )
  cancelledField.value = "7"
  cancelledField.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()
  action(cancelledDialog, "common.cancel").click()
  await settle()
  // Wait past the 300ms reasoning preview debounce: closing the dialog must cancel the pending preview.
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()
  assert.equal(
    sent.filter((message) => message.type === "sessionReasoningClearPreview").length,
    mounted,
    "closing the reasoning dialog cancels a pending debounced preview",
  )
  assert.equal(applies().length, 1, "cancelling the reasoning dialog sends no apply request")
  const cancelledPreview = sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)
  assert(cancelledPreview, "the cancelled reasoning dialog requested a preview")
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: id,
    requestID: cancelledPreview.requestID,
    turns: 1,
    parts: 1,
    tokens: 20,
    unsupported: 0,
    token: "cancelled-token",
  })

  const emptyMenu = await open()
  const emptyItem = items(emptyMenu.menu).find((entry) => label(entry) === "command.session.reasoningClear")
  assert(emptyItem)
  select(emptyItem)
  await settle()
  const emptyDialog = dialog()
  const emptyPreview = sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)
  assert(emptyPreview, "reopening the reasoning dialog requests a preview")
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: id,
    requestID: emptyPreview.requestID,
    turns: 0,
    parts: 0,
    tokens: 0,
    unsupported: 0,
    token: "empty-token",
  })
  assert.equal(
    action(emptyDialog, "command.session.reasoningClear.button").disabled,
    true,
    "empty previews cannot apply",
  )
  assert.deepEqual(
    [...emptyDialog.querySelectorAll<HTMLElement>('[data-slot="reasoning-clear-status"]')].map((node) =>
      node.textContent?.trim(),
    ),
    ["command.session.reasoningClear.empty"],
    "an empty preview renders only the empty status",
  )

  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: id,
    requestID: emptyPreview.requestID,
    turns: 1,
    parts: 1,
    tokens: 20,
    unsupported: 2,
    token: "preserved-token",
  })
  assert.deepEqual(
    [...emptyDialog.querySelectorAll<HTMLElement>('[data-slot="reasoning-clear-status"]')].map((node) =>
      node.textContent?.trim(),
    ),
    ["command.session.reasoningClear.preserved"],
    "a preview with unsupported parts renders the preserved status",
  )
  action(emptyDialog, "common.cancel").click()
  await settle()

  session.reasoningPreview(other, 10)
  const otherPreview = sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)
  assert(otherPreview, "a non-current session can request a reasoning preview")
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: other,
    requestID: otherPreview.requestID,
    turns: 3,
    parts: 4,
    tokens: 70,
    unsupported: 0,
    token: "other-token",
  })
  session.reasoningClear(other, 10, "other-token")
  const otherApply = sent.filter((message) => message.type === "sessionReasoningClear").at(-1)
  assert(otherApply, "a non-current session can request a reasoning apply")
  await emit({
    type: "sessionReasoningCleared",
    sessionID: other,
    requestID: otherApply.requestID,
    parts: 4,
    turns: 3,
    tokens: 70,
  })
  assert.equal(toasts("success").length, successToastCount, "a non-current reasoning clear shows no success toast")

  session.reasoningPreview(other, 10)
  const otherFailurePreview = sent.filter((message) => message.type === "sessionReasoningClearPreview").at(-1)
  assert(otherFailurePreview)
  await emit({
    type: "sessionReasoningClearPreviewed",
    sessionID: other,
    requestID: otherFailurePreview.requestID,
    turns: 3,
    parts: 4,
    tokens: 70,
    unsupported: 0,
    token: "other-failure-token",
  })
  session.reasoningClear(other, 10, "other-failure-token")
  const otherFailureApply = sent.filter((message) => message.type === "sessionReasoningClear").at(-1)
  assert(otherFailureApply)
  await emit({
    type: "sessionReasoningClearFailed",
    operation: "apply",
    sessionID: other,
    requestID: otherFailureApply.requestID,
    code: "unknown",
    error: "The other session failed.",
  })
  assert.equal(toasts("error").length, 0, "a non-current reasoning failure shows no error toast")

  // The tool-output dialog: starts at 10, remembers only a confirmed Clear, and keeps its value apart from reasoning.
  const toolItems = async () => {
    const menu = await open()
    const item = items(menu.menu).find((entry) => label(entry) === "command.session.toolClear")
    assert(item, "the More actions menu exposes Clear old tool output")
    select(item)
    await settle()
    return dialog()
  }
  const input = (node: HTMLInputElement, text: string) => {
    node.value = text
    node.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  }
  const toolPreviews = () => sent.filter((message) => message.type === "sessionToolClearPreview")
  const peek = await toolItems()
  const peekField = peek.querySelector<HTMLInputElement>('input[type="number"]')
  assert(peekField, "the tool dialog exposes the keep-turns field")
  assert.equal(peekField.value, "10", "the tool dialog starts at 10 before any confirmed clear")
  const peekPreview = toolPreviews().at(-1)
  assert(peekPreview, "the tool dialog requests a preview on first open")
  assert.equal(peekPreview.keepTurns, 10, "the tool dialog previews 10 on first open")
  await emit({
    type: "sessionToolClearPreviewed",
    sessionID: id,
    requestID: peekPreview.requestID,
    turns: 1,
    parts: 1,
    tokens: 10,
    token: "tool-token-peek",
  })
  input(peekField, "4")
  await settle()
  action(peek, "common.cancel").click()
  await settle()
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()
  const tools = await toolItems()
  const toolField = tools.querySelector<HTMLInputElement>('input[type="number"]')
  assert(toolField, "the reopened tool dialog exposes the keep-turns field")
  assert.equal(toolField.value, "10", "cancelling a tool dialog does not remember the value that was tried")
  const toolFirst = toolPreviews().at(-1)
  assert(toolFirst, "reopening the tool dialog requests a preview")
  await emit({
    type: "sessionToolClearPreviewed",
    sessionID: id,
    requestID: toolFirst.requestID,
    turns: 2,
    parts: 4,
    tokens: 90,
    token: "tool-token-10",
  })
  input(toolField, "3")
  await settle()
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()
  const toolSecond = toolPreviews().at(-1)
  assert(toolSecond && toolSecond.requestID !== toolFirst.requestID, "changing keep turns previews again")
  assert.equal(toolSecond.keepTurns, 3, "the tool dialog previews the edited keep-turns")
  await emit({
    type: "sessionToolClearPreviewed",
    sessionID: id,
    requestID: toolSecond.requestID,
    turns: 1,
    parts: 2,
    tokens: 40,
    token: "tool-token-3",
  })
  action(tools, "command.session.toolClear.button").click()
  await settle()
  const toolApply = sent.filter((message) => message.type === "sessionToolClear").at(-1)
  assert(toolApply, "confirming the tool dialog posts an apply request")
  assert.deepEqual(toolApply, {
    type: "sessionToolClear",
    sessionID: id,
    requestID: toolApply.requestID,
    keepTurns: 3,
    token: "tool-token-3",
  })
  await emit({
    type: "sessionToolCleared",
    sessionID: id,
    requestID: toolApply.requestID,
    parts: 2,
    turns: 1,
    tokens: 40,
  })
  assert.equal(
    tools.querySelector('[role="dialog"]')?.hasAttribute("data-closed"),
    true,
    "a successful tool clear closes the dialog",
  )
  assert.equal(
    toasts("success").some((node) => node.textContent?.includes("command.session.toolClear.success")),
    true,
    "a current-session tool clear shows a success toast",
  )
  const again = await toolItems()
  assert.equal(
    again.querySelector<HTMLInputElement>('input[type="number"]')?.value,
    "3",
    "the tool dialog starts from the last confirmed keep-turns",
  )
  assert.equal(toolPreviews().at(-1)?.keepTurns, 3, "the tool dialog previews the remembered keep-turns on open")
  action(again, "common.cancel").click()
  await settle()
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()
  assert.equal(
    sent.filter((message) => message.type === "sessionToolClear").length,
    1,
    "cancelling the reopened tool dialog sends no apply request",
  )
  const reasoningAgain = await open()
  const reasoningRow = items(reasoningAgain.menu).find((entry) => label(entry) === "command.session.reasoningClear")
  assert(reasoningRow)
  select(reasoningRow)
  await settle()
  const reasoningDialogAgain = dialog()
  assert.equal(
    reasoningDialogAgain.querySelector<HTMLInputElement>('input[type="number"]')?.value,
    "5",
    "the reasoning value is independent of the tool value",
  )
  action(reasoningDialogAgain, "common.cancel").click()
  await settle()
  await new Promise((resolve) => window.setTimeout(resolve, 350))
  await settle()

  session.selectCloudSession("preview")
  await emit({
    type: "cloudSessionDataLoaded",
    cloudSessionId: "preview",
    title: "Cloud preview",
    messages: [{ id: "cloud-message", sessionID: "cloud:preview", role: "user", createdAt: now }],
  })
  assert.equal(session.currentSessionID(), "cloud:preview", "cloud preview becomes the current session")
  assert.equal(session.messages().length, 1, "cloud preview has non-empty messages")
  const cloudMenu = await open()
  const cloudReasoningItem = items(cloudMenu.menu).find((entry) => label(entry) === "command.session.reasoningClear")
  assert(cloudReasoningItem, "the cloud preview exposes the reasoning action row")
  assert.equal(
    cloudReasoningItem.hasAttribute("data-disabled"),
    true,
    "cloud preview keeps reasoning clear disabled without a local session id",
  )
  press(cloudMenu.button, "pointerdown")
  await settle()
  session.selectSession(id)
  await settle()

  // 1. Menu contract: the delete row is appended after the existing actions, in order.
  const menu = await open()
  assert.deepEqual(
    items(menu.menu).map(label),
    [
      "chat.search.toggle",
      "command.session.compact",
      "command.session.toolClear",
      "command.session.reasoningClear",
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
  assert.deepEqual(errors, [], "the task header actions scenario raises no window errors")
} finally {
  dispose()
  await window.happyDOM.cancelAsync()
  await window.happyDOM.close()
}

process.exit(0)
