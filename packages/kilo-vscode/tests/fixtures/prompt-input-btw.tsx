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
  opts: { box: string; connected?: boolean; blocked?: () => boolean },
) {
  const connected = opts.connected ?? true
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding>
        <ServerContext.Provider
          value={
            {
              connectionState: () => (connected ? "connected" : "error"),
              isConnected: () => connected,
              gitInstalled: () => false,
              workspaceDirectory: () => "/repo",
              providerUsage: () => undefined,
              requestProviderUsage: () => {},
            } as never
          }
        >
          <SessionContext.Provider value={session as never}>
            <PromptInput boxId={opts.box} blocked={opts.blocked} />
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
await noSession()
await blocked()
await disconnected()
await escape()
