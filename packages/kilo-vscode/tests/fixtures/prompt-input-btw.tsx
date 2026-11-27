import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { BtwItem } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
class CSSStyleSheetStub {
  replaceSync() {}
  replace() {
    return Promise.resolve(this)
  }
}
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  getComputedStyle: window.getComputedStyle.bind(window),
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  SVGElement: window.SVGElement,
  ShadowRoot: window.ShadowRoot,
  customElements: window.customElements,
  CSSStyleSheet: CSSStyleSheetStub,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  IntersectionObserver: IntersectionObserverStub,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})

const posts: Array<Record<string, unknown>> = []

globalThis.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => posts.push(message as Record<string, unknown>),
  getState: () => undefined,
  setState: () => {},
})

const { render } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { post } = await import("../../webview-ui/src/utils/webview-message")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { ServerContext } = await import("../../webview-ui/src/context/server")
const { PromptInput } = await import("../../webview-ui/src/components/chat/PromptInput")
const { createSessionBtw } = await import("../../webview-ui/src/context/session-btw")

type Btw = ReturnType<typeof createSessionBtw>

const ENTRY = "btw_entry"
const THREAD = "btw_thread"

async function settle() {
  await window.happyDOM.waitUntilComplete()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

async function flush() {
  const tick = Promise.withResolvers<void>()
  setTimeout(tick.resolve, 0)
  await tick.promise
}

function makeSession(withSession = true) {
  const sends: string[] = []
  let aborts = 0
  const btw = createSessionBtw({
    post: (message) => posts.push(message as unknown as Record<string, unknown>),
    usage: () => {},
  })
  const base = mockSessionValue({ id: "session", status: "busy" })
  const session = {
    ...base,
    currentSessionID: withSession ? base.currentSessionID : () => undefined,
    btw,
    sendMessage: (message: string) => {
      sends.push(message)
      return sends.length
    },
    sendCommand: (name: string, args: string) => {
      sends.push(`/${name} ${args}`)
      return true
    },
    deferMessage: (input: { text: string }) => {
      sends.push(input.text)
      return true
    },
    abort: () => {
      aborts += 1
    },
  }
  return {
    session,
    btw,
    sends,
    aborts: () => aborts,
  }
}

function mount(
  session: ReturnType<typeof makeSession>["session"],
  opts: {
    box: string
    connected?: boolean | (() => boolean)
    blocked?: () => boolean
    pending?: string
    edit?: { sessionID: string; messageID: string }
    speech?: boolean
  },
) {
  const connected = opts.connected ?? true
  const online = () => (typeof connected === "function" ? connected() : connected)
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding config={opts.speech ? {} : undefined} kiloAuth={opts.speech}>
        <ServerContext.Provider
          value={
            {
              connectionState: () => (online() ? "connected" : "error"),
              isConnected: online,
              gitInstalled: () => false,
              workspaceDirectory: () => "/repo",
              profileData: () => null,
              providerUsage: () => undefined,
              requestProviderUsage: () => {},
            } as never
          }
        >
          <SessionContext.Provider value={session as never}>
            <PromptInput boxId={opts.box} pendingSessionID={opts.pending} blocked={opts.blocked} edit={opts.edit} />
          </SessionContext.Provider>
        </ServerContext.Provider>
      </StoryProviders>
    ),
    root,
  )
  return { root, dispose }
}

function textarea(root: HTMLElement) {
  const input = root.querySelector<HTMLTextAreaElement>("textarea.prompt-input")
  assert.ok(input, "missing element: textarea.prompt-input")
  return input
}

function type(input: HTMLTextAreaElement, value: string) {
  input.value = value
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
}

function typeAt(input: HTMLTextAreaElement, value: string) {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  input.value = input.value.slice(0, start) + value + input.value.slice(end)
  input.setSelectionRange(start + value.length, start + value.length)
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }))
}

function submit(input: HTMLTextAreaElement) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}

function button(root: HTMLElement, selector: string, label: string) {
  const target = [...root.querySelectorAll<HTMLButtonElement>(selector)].find((item) =>
    item.textContent?.includes(label),
  )
  assert.ok(target, `missing element: ${label}`)
  return target
}

function click(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

function host(data: Record<string, unknown>) {
  post(data)
}

function start(btw: Btw, question: string) {
  btw.ask("session", question)
  const request = posts.find((message) => message.type === "btwAsk") as { requestID: string } | undefined
  assert.ok(request, "the fixture starts a side question")
  const item: BtwItem = {
    id: ENTRY,
    sessionID: "session",
    threadID: THREAD,
    status: "running",
    question,
    answer: "",
    providerID: "kilo",
    modelID: "test",
    cost: 0,
    time: { created: 1 },
  }
  btw.handleMessage({ type: "btwStarted", sessionID: "session", requestID: request.requestID, item })
  return item
}

function seed(btw: Btw, question: string, answer: string) {
  const item = start(btw, question)
  btw.handleMessage({
    type: "btwUpdated",
    sessionID: "session",
    item: { ...item, status: "done", answer, time: { created: 1, completed: 2 } },
  })
}

async function ask() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "ask" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "a /btw scenario starts with an empty draft")

    type(input, "/btw why?")
    submit(input)
    await settle()

    const sent = posts.find((message) => message.type === "btwAsk") as
      | { question?: string; sessionID?: string; threadID?: string }
      | undefined
    assert.ok(sent, "a /btw line starts a side question instead of a chat message")
    assert.equal(sent.question, "why?", "the side question keeps the typed question")
    assert.equal(sent.sessionID, "session", "the side question is asked in the current session")
    assert.equal(sent.threadID, undefined, "a fresh side question does not reuse a thread")
    assert.deepEqual(current.sends, [], "a /btw line does not reach the agent as a chat message")
    assert.equal(input.value, "", "the /btw line leaves the draft")
  } finally {
    dispose()
    root.remove()
  }
}

async function followEmpty() {
  posts.length = 0
  const current = makeSession()
  seed(current.btw, "why?", "because.")
  posts.length = 0
  const { root, dispose } = mount(current.session, { box: "follow-empty" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "a follow scenario starts with an empty draft")
    assert.equal(current.btw.state("session").thread, THREAD, "a started side question opens its own thread")
    assert.ok(root.querySelector(".prompt-btw-item"), "a started side question opens its own thread")

    const follow = current.btw.follow
    const order: string[] = []
    current.btw.follow = (id) => {
      order.push(input.value)
      return follow(id)
    }

    click(button(root, ".prompt-btw-actions button", "Follow up"))
    await flush()
    assert.equal(input.value, "/btw ", "Follow up puts the /btw prefix in the textarea")
    assert.equal(input.selectionStart, 5, "Follow up puts the caret after the /btw prefix")
    assert.equal(input.selectionEnd, 5, "Follow up puts the caret after the /btw prefix")
    assert.equal(document.activeElement, input, "Follow up focuses the prompt input")
    assert.deepEqual(order, ["/btw "], "Follow up stages the prompt before arming follow-up mode")
    assert.equal(current.btw.state("session").follow, true, "Follow up arms follow-up mode")

    typeAt(input, "why follow?")
    assert.equal(input.value, "/btw why follow?", "typing continues at the caret after the prefix")
    assert.equal(input.selectionStart, 16, "typing continues at the caret after the prefix")
    submit(input)
    await settle()

    const sent = posts.find((message) => message.type === "btwAsk") as
      | { question?: string; sessionID?: string; threadID?: string }
      | undefined
    assert.ok(sent, "a follow-up sends a /btw ask")
    assert.equal(sent.question, "why follow?", "a follow-up keeps the typed question")
    assert.equal(sent.sessionID, "session", "a follow-up asks in the current session")
    assert.equal(sent.threadID, THREAD, "a follow-up asks inside the previous side-question thread")
    assert.notEqual(sent.threadID, ENTRY, "a follow-up asks inside the previous side-question thread")
    assert.deepEqual(current.sends, [], "a follow-up does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function followDraft() {
  posts.length = 0
  const current = makeSession()
  seed(current.btw, "why?", "because.")
  posts.length = 0
  const { root, dispose } = mount(current.session, { box: "follow-draft" })
  try {
    await settle()
    const input = textarea(root)

    type(input, "draft text")
    await flush()
    click(button(root, ".prompt-btw-actions button", "Follow up"))
    await flush()
    assert.equal(input.value, "/btw draft text", "Follow up keeps the typed draft after the prefix")
    assert.equal(input.selectionStart, 5, "Follow up puts the caret after the /btw prefix")
    assert.equal(input.selectionEnd, 5, "Follow up puts the caret after the /btw prefix")
    assert.equal(document.activeElement, input, "Follow up focuses the prompt input")
    assert.equal(current.btw.state("session").follow, true, "Follow up arms follow-up mode")

    submit(input)
    await settle()
    const sent = posts.find((message) => message.type === "btwAsk") as
      | { question?: string; threadID?: string }
      | undefined
    assert.ok(sent, "a follow-up sends a /btw ask")
    assert.equal(sent.question, "draft text", "a follow-up keeps the typed draft as its question")
    assert.equal(sent.threadID, THREAD, "a follow-up asks inside the previous side-question thread")
    assert.deepEqual(current.sends, [], "a follow-up does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function followExisting() {
  posts.length = 0
  const current = makeSession()
  seed(current.btw, "why?", "because.")
  posts.length = 0
  const { root, dispose } = mount(current.session, { box: "follow-existing" })
  try {
    await settle()
    const input = textarea(root)

    type(input, "/btw keep me?")
    await flush()
    click(button(root, ".prompt-btw-actions button", "Follow up"))
    await flush()
    assert.equal(input.value, "/btw keep me?", "Follow up keeps an existing /btw draft unchanged")
    assert.equal(document.activeElement, input, "Follow up focuses the prompt input")
    assert.equal(current.btw.state("session").follow, true, "Follow up arms follow-up mode")
  } finally {
    dispose()
    root.remove()
  }
}

async function insert() {
  posts.length = 0
  const current = makeSession()
  seed(current.btw, "why?", "because.")
  posts.length = 0
  const { root, dispose } = mount(current.session, { box: "insert" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "an insert scenario starts with an empty draft")

    type(input, "draft text")
    await flush()
    click(button(root, ".prompt-btw-actions button", "Insert"))
    await flush()

    const quote = "> **Side question:** why?\n>\n> because.\n\n"
    assert.equal(input.value, quote + "draft text", "Insert places the quoted answer above the existing draft")
  } finally {
    dispose()
    root.remove()
  }
}

async function history() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "history" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "a history scenario starts with an empty draft")

    type(input, "/btw")
    submit(input)
    await flush()
    submit(input)
    await settle()

    assert.ok(
      posts.some((message) => message.type === "btwHistory"),
      "a bare /btw lists side-question history",
    )
    assert.ok(root.querySelector(".prompt-btw"), "a bare /btw opens the side-question card")
    assert.equal(current.btw.state("session").history, true, "a bare /btw switches the card to history")
    assert.ok(!posts.some((message) => message.type === "btwAsk"), "a bare /btw does not start a side question")
    assert.deepEqual(current.sends, [], "a bare /btw does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function compose() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "compose" })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    assert.equal(current.btw.state("session").open, true, "the prompt ask button opens the side-question card")
    assert.equal(current.btw.state("session").compose, true, "the prompt ask button starts a fresh card question")
    assert.ok(!posts.some((message) => message.type === "btwAsk"), "opening the card does not ask by itself")

    const input = root.querySelector<HTMLInputElement>(".prompt-btw-ask input")
    assert.ok(input, "the opened card shows its own question input")
    assert.equal(document.activeElement, input, "the opened card focuses its question input")

    input.value = "why now?"
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "why now?", inputType: "insertText" }))
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()

    const sent = posts.find((message) => message.type === "btwAsk") as
      | { question?: string; sessionID?: string; threadID?: string }
      | undefined
    assert.ok(sent, "the card question input asks a side question")
    assert.equal(sent.question, "why now?", "the card question input keeps the typed question")
    assert.equal(sent.sessionID, "session", "the card question asks in the current session")
    assert.equal(sent.threadID, undefined, "the card question asks a fresh side question")

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flush()
    assert.equal(current.btw.state("session").open, false, "Escape in the card input closes the side-question card")
    assert.equal(document.activeElement, textarea(root), "closing the card returns focus to the chat input")
  } finally {
    dispose()
    root.remove()
  }
}

async function pending() {
  posts.length = 0
  const current = makeSession(false)
  const { root, dispose } = mount(current.session, { box: "pending", pending: "pending_1" })
  try {
    await settle()
    assert.ok(
      !root.querySelector('[aria-label="Ask a side question"]'),
      "the prompt ask button is absent in a pending session",
    )
    assert.equal(current.btw.state("pending_1").open, false, "a pending session does not open the card")
  } finally {
    dispose()
    root.remove()
  }
}

async function closeFocus() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "close-focus" })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const close = root.querySelector<HTMLElement>('[aria-label="Close side question"]')
    assert.ok(close, "missing element: Close side question")
    click(close)
    await flush()

    assert.equal(current.btw.state("session").open, false, "the card header closes the side-question card")
    assert.equal(document.activeElement, textarea(root), "closing the card returns focus to the chat input")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardGuard() {
  posts.length = 0
  const current = makeSession()
  let blocked = false
  const { root, dispose } = mount(current.session, { box: "card-guard", blocked: () => blocked })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    blocked = true
    const input = root.querySelector<HTMLInputElement>(".prompt-btw-ask input")
    assert.ok(input, "the opened card shows its own question input")
    input.value = "blocked?"
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "blocked?", inputType: "insertText" }))

    const send = root.querySelector<HTMLElement>('[aria-label="Send side question"]')
    assert.ok(send, "missing element: Send side question")
    click(send)
    await flush()

    assert.ok(!posts.some((message) => message.type === "btwAsk"), "a blocked card send does not start a side question")
    assert.equal(
      root.querySelector(".prompt-btw-hint")?.textContent?.trim(),
      "Answer the pending request first, then ask your side question.",
      "a blocked card send asks for the pending request to be answered first",
    )
    assert.equal(input.value, "blocked?", "a blocked card send keeps the card question draft")
  } finally {
    dispose()
    root.remove()
  }
}

async function noSession() {
  posts.length = 0
  const current = makeSession(false)
  const { root, dispose } = mount(current.session, { box: "no-session" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "a missing-session scenario starts with an empty draft")

    type(input, "/btw why?")
    submit(input)
    await flush()

    const hint = root.querySelector(".prompt-btw-hint")?.textContent?.trim()
    assert.equal(
      hint,
      "Start a conversation first, then ask a side question.",
      "a /btw without a session explains that a conversation is needed",
    )
    assert.ok(
      !posts.some((message) => message.type === "btwAsk"),
      "a /btw without a session does not start a side question",
    )
    assert.ok(
      !root.querySelector('[aria-label="Ask a side question"]'),
      "the prompt ask button is absent without a session",
    )
    assert.deepEqual(current.sends, [], "a /btw without a session does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function blocked() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "blocked", blocked: () => true })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "a blocked scenario starts with an empty draft")

    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()
    assert.equal(current.btw.state("session").open, false, "a blocked ask button does not open the card")
    assert.equal(
      root.querySelector(".prompt-btw-hint")?.textContent?.trim(),
      "Answer the pending request first, then ask your side question.",
      "a blocked ask button asks for the pending request to be answered first",
    )

    type(input, "/btw why?")
    submit(input)
    await flush()

    const hint = root.querySelector(".prompt-btw-hint")?.textContent?.trim()
    assert.equal(
      hint,
      "Answer the pending request first, then ask your side question.",
      "a /btw while blocked asks for the pending request to be answered first",
    )
    assert.ok(!posts.some((message) => message.type === "btwAsk"), "a blocked /btw does not start a side question")
    assert.deepEqual(current.sends, [], "a blocked /btw does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function disconnected() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "disconnected", connected: false })
  try {
    await settle()
    const input = textarea(root)

    assert.equal(
      input.placeholder,
      "Connection failed. Check the output panel or restart the extension.",
      "a disconnected prompt explains the connection failure",
    )

    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()
    assert.equal(current.btw.state("session").open, false, "a disconnected ask button does not open the card")
    assert.equal(
      root.querySelector(".prompt-btw-hint")?.textContent?.trim(),
      "Wait for the connection to come back, then ask your side question.",
      "a disconnected ask button explains that the connection is down",
    )

    type(input, "/btw why?")
    submit(input)
    await flush()

    assert.ok(
      !posts.some((message) => message.type === "btwAsk"),
      "a /btw while disconnected does not start a side question",
    )
    const hint = root.querySelector(".prompt-btw-hint")?.textContent?.trim()
    assert.equal(
      hint,
      "Wait for the connection to come back, then ask your side question.",
      "a /btw while disconnected explains that the connection is down",
    )
    assert.deepEqual(current.sends, [], "a /btw while disconnected does not reach the agent as a chat message")
  } finally {
    dispose()
    root.remove()
  }
}

async function editHint() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, {
    box: "edit-hint",
    edit: { sessionID: "session", messageID: "message" },
  })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    assert.equal(
      root.querySelector(".prompt-btw-hint")?.textContent?.trim(),
      "Finish editing the message first, then ask your side question.",
      "an edit-mode ask button explains that editing must finish first",
    )
    assert.equal(current.btw.state("session").open, false, "an edit-mode ask button does not open the card")
  } finally {
    dispose()
    root.remove()
  }
}

async function staleHint() {
  posts.length = 0
  const current = makeSession()
  const [online, setOnline] = createSignal(false)
  const { root, dispose } = mount(current.session, { box: "stale-hint", connected: online })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()
    assert.equal(
      root.querySelector(".prompt-btw-hint")?.textContent?.trim(),
      "Wait for the connection to come back, then ask your side question.",
      "a disconnected ask button explains that the connection is down",
    )

    setOnline(true)
    await settle()
    assert.equal(
      root.querySelector(".prompt-btw-hint"),
      null,
      "the disconnected hint clears once the connection returns",
    )
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeech() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech", speech: true })
  try {
    await settle()
    const input = textarea(root)
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const card = root.querySelector<HTMLInputElement>(".prompt-btw-ask input")
    assert.ok(card, "the side-question card shows its own question input")
    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "the side-question card shows its own voice input button")
    const main = root.querySelector<HTMLElement>('.prompt-input-hint-pinned [aria-label="Start voice input"]')
    assert.ok(main, "the main microphone keeps its own label while the card is idle")
    assert.notEqual(
      main.getAttribute("aria-label"),
      mic.getAttribute("aria-label"),
      "the main and card microphones have distinct labels",
    )

    card.value = "draft"
    card.dispatchEvent(new InputEvent("input", { bubbles: true, data: "draft", inputType: "insertText" }))
    click(mic)
    await flush()
    assert.equal(
      root.querySelector(".prompt-input-hint-pinned .prompt-speech-button"),
      null,
      "the main microphone hides while the card records",
    )

    const send = root.querySelector<HTMLButtonElement>('[aria-label="Send side question"]')
    assert.ok(send, "missing element: Send side question")
    assert.equal(send.disabled, true, "the card send is disabled while speech starts")

    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()
    assert.ok(!posts.some((message) => message.type === "btwAsk"), "card speech blocks a card ask")
    assert.equal(card.value, "draft", "a blocked card ask keeps the speech draft")

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()
    host({ type: "speechToTextResult", requestId: start.requestId, text: "spoken question" })
    await settle()

    const question = root.querySelector<HTMLInputElement>(".prompt-btw-ask input")
    assert.ok(question, "the card question input stays visible")
    assert.ok(question.value.includes("spoken question"), "the card voice input fills the card question")
    assert.ok(!posts.some((message) => message.type === "btwAsk"), "the card voice input does not send a side question")
    assert.equal(input.value, "", "the card voice input leaves the main composer unchanged")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechHistory() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-history", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "missing element: card voice input")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    const history = root.querySelector<HTMLElement>('[aria-label="Side question history"]')
    assert.ok(history, "missing element: Side question history")
    click(history)
    await flush()

    const cancel = posts.find((message) => message.type === "speechToTextCancel") as { requestId?: string } | undefined
    assert.ok(cancel, "opening history cancels the card speech recording")
    assert.equal(cancel.requestId, start.requestId, "opening history cancels the card speech recording")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechExternalClose() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-external-close", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "missing element: card voice input")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    const input = textarea(root)
    input.focus()
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flush()

    assert.equal(current.btw.state("session").open, false, "Escape in the main composer closes the side-question card")
    const cancel = posts.find((message) => message.type === "speechToTextCancel") as { requestId?: string } | undefined
    assert.ok(cancel, "closing the card from outside cancels its speech recording")
    assert.equal(cancel.requestId, start.requestId, "closing the card from outside cancels its speech recording")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechStartingClose() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-starting-close", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "missing element: card voice input")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    const close = root.querySelector<HTMLElement>('[aria-label="Close side question"]')
    assert.ok(close, "missing element: Close side question")
    click(close)
    await flush()

    const cancel = posts.find((message) => message.type === "speechToTextCancel") as { requestId?: string } | undefined
    assert.ok(cancel, "closing the card cancels its starting speech recording")
    assert.equal(cancel.requestId, start.requestId, "closing the card cancels its starting speech recording")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechTranscribingClose() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-transcribing-close", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "missing element: card voice input")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    const recording = root.querySelector<HTMLElement>('.prompt-btw-ask [aria-label="Recording. Click to stop."]')
    assert.ok(recording, "the card voice input shows the recording state")
    click(recording)
    await flush()

    const stop = posts.find((message) => message.type === "speechToTextStop") as { requestId?: string } | undefined
    assert.ok(stop, "clicking the recording card microphone stops the recording")
    assert.equal(stop.requestId, start.requestId, "clicking the recording card microphone stops the recording")

    const close = root.querySelector<HTMLElement>('[aria-label="Close side question"]')
    assert.ok(close, "missing element: Close side question")
    click(close)
    await flush()

    const cancel = posts.find((message) => message.type === "speechToTextCancel") as { requestId?: string } | undefined
    assert.ok(cancel, "closing the card cancels its transcribing speech")
    assert.equal(cancel.requestId, start.requestId, "closing the card cancels its transcribing speech")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechMainSend() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-main-send", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "missing element: card voice input")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    const input = textarea(root)
    type(input, "hello")
    const send = root.querySelector<HTMLButtonElement>('[aria-label="Send"]')
    assert.ok(send, "missing element: Send")
    assert.equal(send.disabled, true, "the main send is disabled while the card records")

    submit(input)
    await flush()

    assert.ok(
      !posts.some((message) => message.type === "speechToTextStop"),
      "the main send does not stop the card recording",
    )
    assert.ok(
      !posts.some((message) => message.type === "speechToTextCancel"),
      "the main send does not cancel the card recording",
    )
    assert.deepEqual(current.sends, [], "the main send does not send chat while the card records")
    const recording = root.querySelector<HTMLElement>('.prompt-btw-ask [aria-label="Recording. Click to stop."]')
    assert.ok(recording, "the card keeps recording after a blocked main send")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechShortcut() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-shortcut", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const input = root.querySelector<HTMLInputElement>(".prompt-btw-ask input")
    assert.ok(input, "missing element: card question input")
    input.focus()
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
    await flush()
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "k", bubbles: true }) as unknown as Parameters<typeof window.dispatchEvent>[0],
    )
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card shortcut starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
    await flush()
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "k", bubbles: true }) as unknown as Parameters<typeof window.dispatchEvent>[0],
    )
    await flush()

    const stop = posts.find((message) => message.type === "speechToTextStop") as { requestId?: string } | undefined
    assert.ok(stop, "the card shortcut stops a card speech recording")
    assert.equal(stop.requestId, start.requestId, "the card shortcut stops a card speech recording")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardMainSpeech() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-main-speech", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const main = root.querySelector<HTMLElement>('.prompt-input-hint-pinned [aria-label="Start voice input"]')
    assert.ok(main, "the main microphone is available while the card is idle")
    click(main)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the main microphone starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    assert.ok(
      !root.querySelector('.prompt-btw-ask [aria-label="Start voice input for the side question"]'),
      "the card microphone hides while the main microphone records",
    )

    const close = root.querySelector<HTMLElement>('[aria-label="Close side question"]')
    assert.ok(close, "missing element: Close side question")
    click(close)
    await flush()
    assert.ok(
      !posts.some((message) => message.type === "speechToTextCancel"),
      "closing the card does not cancel main speech",
    )

    host({ type: "speechToTextResult", requestId: start.requestId, text: "main dictation" })
    await settle()
    assert.equal(textarea(root).value, "main dictation", "main speech fills the main composer")
  } finally {
    dispose()
    root.remove()
  }
}

async function cardSpeechClose() {
  posts.length = 0
  const current = makeSession()
  const { root, dispose } = mount(current.session, { box: "card-speech-close", speech: true })
  try {
    await settle()
    const ask = root.querySelector<HTMLElement>('[aria-label="Ask a side question"]')
    assert.ok(ask, "missing element: Ask a side question")
    click(ask)
    await flush()

    const mic = root.querySelector<HTMLElement>(
      '.prompt-btw-ask [aria-label="Start voice input for the side question"]',
    )
    assert.ok(mic, "the side-question card shows its own voice input button")
    click(mic)
    await flush()

    const start = posts.find((message) => message.type === "speechToTextStart") as { requestId?: string } | undefined
    assert.ok(start?.requestId, "the card voice input starts a speech recording")
    host({ type: "speechToTextStarted", requestId: start.requestId })
    await flush()

    const close = root.querySelector<HTMLElement>('[aria-label="Close side question"]')
    assert.ok(close, "missing element: Close side question")
    click(close)
    await flush()

    const cancels = posts.filter((message) => message.type === "speechToTextCancel") as Array<{ requestId?: string }>
    assert.equal(cancels.length, 1, "closing the card cancels its speech recording")
    assert.equal(cancels[0]?.requestId, start.requestId, "closing the card cancels its speech recording")
    assert.equal(current.btw.state("session").open, false, "the card header closes the side-question card")
  } finally {
    dispose()
    root.remove()
  }
}

async function escape() {
  posts.length = 0
  const current = makeSession()
  start(current.btw, "why?")
  posts.length = 0
  const { root, dispose } = mount(current.session, { box: "escape" })
  try {
    await settle()
    const input = textarea(root)
    assert.equal(input.value, "", "an escape scenario starts with an empty draft")

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flush()
    assert.equal(current.aborts(), 0, "Escape closes the side-question card before aborting the agent")
    const cancel = posts.find((message) => message.type === "btwCancel") as
      | { sessionID?: string; btwID?: string }
      | undefined
    assert.ok(cancel, "Escape cancels the running side question")
    assert.equal(cancel.sessionID, "session", "Escape cancels the running side question")
    assert.equal(cancel.btwID, ENTRY, "Escape cancels the running side question")
    assert.notEqual(cancel.btwID, THREAD, "Escape cancels the running side question")

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flush()
    assert.equal(current.aborts(), 1, "a second Escape aborts the busy agent")
  } finally {
    dispose()
    root.remove()
  }
}

await ask()
await followEmpty()
await followDraft()
await followExisting()
await insert()
await history()
await pending()
await compose()
await closeFocus()
await cardGuard()
await noSession()
await blocked()
await disconnected()
await escape()
await editHint()
await staleHint()
await cardSpeech()
await cardSpeechHistory()
await cardSpeechExternalClose()
await cardSpeechStartingClose()
await cardSpeechTranscribingClose()
await cardSpeechMainSend()
await cardSpeechShortcut()
await cardMainSpeech()
await cardSpeechClose()
