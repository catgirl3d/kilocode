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
const clipboard: string[] = []

globalThis.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => posts.push(message as Record<string, unknown>),
  getState: () => undefined,
  setState: () => {},
})

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => {
      clipboard.push(text)
      return Promise.resolve()
    },
  },
})

const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { BtwCard } = await import("../../webview-ui/src/components/chat/BtwCard")
const { createSessionBtw } = await import("../../webview-ui/src/context/session-btw")

const ENTRY = "btw_entry"
const THREAD = "btw_thread"
const QUOTE = "> **Side question:** why?\n>\n> because.\n\n"

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

function makeSession() {
  const btw = createSessionBtw({
    post: (message) => posts.push(message as unknown as Record<string, unknown>),
    usage: () => {},
  })
  const base = mockSessionValue({ id: "session" })
  return {
    session: {
      ...base,
      btw,
    },
    btw,
  }
}

function mount(
  current: ReturnType<typeof makeSession>,
  handlers: { insert: (text: string) => void; follow: () => void },
) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding>
        <SessionContext.Provider value={current.session as never}>
          <BtwCard sessionID="session" onInsert={handlers.insert} onFollow={handlers.follow} />
        </SessionContext.Provider>
      </StoryProviders>
    ),
    root,
  )
  return { root, dispose }
}

function click(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

function action(root: HTMLElement, label: string) {
  const target = [...root.querySelectorAll<HTMLButtonElement>('.prompt-btw-actions [data-component="button"]')].find(
    (button) => button.textContent?.includes(label),
  )
  assert.ok(target, `missing element: ${label}`)
  return target
}

function icon(root: HTMLElement, label: string) {
  const target = root.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  assert.ok(target, `missing element: ${label}`)
  return target
}

function item(overrides: Partial<BtwItem> = {}): BtwItem {
  return {
    id: ENTRY,
    sessionID: "session",
    threadID: THREAD,
    status: "running",
    question: "why?",
    answer: "",
    providerID: "kilo",
    modelID: "test",
    cost: 0,
    time: { created: 1 },
    ...overrides,
  }
}

function start(current: ReturnType<typeof makeSession>, overrides: Partial<BtwItem> = {}) {
  current.btw.ask("session", overrides.question ?? "why?")
  const request = posts.find((message) => message.type === "btwAsk") as { requestID: string } | undefined
  assert.ok(request, "the fixture starts a side question")
  const running = item(overrides)
  current.btw.handleMessage({ type: "btwStarted", sessionID: "session", requestID: request.requestID, item: running })
  return running
}

function update(current: ReturnType<typeof makeSession>, next: BtwItem) {
  current.btw.handleMessage({ type: "btwUpdated", sessionID: "session", item: next })
}

function finish(current: ReturnType<typeof makeSession>) {
  const running = start(current)
  const done: BtwItem = {
    ...running,
    status: "done",
    answer: "because.",
    time: { created: 1, completed: 2 },
  }
  update(current, done)
  return done
}

async function cancel() {
  posts.length = 0
  const current = makeSession()
  start(current)
  posts.length = 0
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    const running = root.querySelector(".prompt-btw-running")
    assert.ok(running, "a running side question shows its cancel control")
    const cancel = running.querySelector<HTMLButtonElement>('[data-component="button"]')
    assert.ok(cancel, "missing element: cancel")
    click(cancel)
    await flush()
    const message = posts.find((post) => post.type === "btwCancel") as
      | { sessionID?: string; btwID?: string }
      | undefined
    assert.ok(message, "the side-question cancel control cancels the running answer")
    assert.equal(message.sessionID, "session", "the side-question cancel control cancels the running answer")
    assert.equal(message.btwID, ENTRY, "the side-question cancel control names the running entry")
    assert.notEqual(message.btwID, THREAD, "the side-question cancel control names the running entry")
  } finally {
    dispose()
    root.remove()
  }
}

async function actions() {
  posts.length = 0
  clipboard.length = 0
  const current = makeSession()
  finish(current)
  const inserts: string[] = []
  const follows: string[] = []
  const order: boolean[] = []
  const { root, dispose } = mount(current, {
    insert: (text) => inserts.push(text),
    follow: () => {
      order.push(current.btw.state("session").follow)
      follows.push("follow")
    },
  })
  try {
    await settle()

    const question = root.querySelector(".prompt-btw-question")
    assert.ok(question, "a finished side question shows its question")
    assert.equal(question.textContent?.trim(), "why?", "a finished side question shows its question")
    const answer = root.querySelector(".prompt-btw-answer")
    assert.ok(answer, "a finished side question shows its answer")
    assert.equal(answer.textContent?.trim(), "because.", "a finished side question shows its answer")

    click(action(root, "Follow up"))
    await flush()
    assert.equal(follows.length, 1, "Follow up notifies the prompt to stage the /btw prefix")
    assert.deepEqual(order, [false], "Follow up stages the prompt before arming follow-up mode")
    assert.equal(current.btw.state("session").follow, true, "Follow up arms follow-up mode")

    click(action(root, "Insert"))
    await flush()
    assert.equal(inserts.at(-1), QUOTE, "Insert hands the quoted answer to the prompt")

    const copy = action(root, "Copy answer")
    click(copy)
    await flush()
    assert.equal(clipboard.at(-1), "because.", "Copy writes the answer to the clipboard")
    assert.equal(copy.dataset.icon, "check-small", "Copy briefly marks the answer as copied")

    await Bun.sleep(2200)
    await flush()
    assert.equal(copy.dataset.icon, "copy", "Copy clears the copied mark after two seconds")
  } finally {
    dispose()
    root.remove()
  }
}

async function headerHistory() {
  posts.length = 0
  const current = makeSession()
  finish(current)
  posts.length = 0
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    click(icon(root, "Side question history"))
    await flush()
    assert.ok(
      posts.some((message) => message.type === "btwHistory" && message.sessionID === "session"),
      "the card header opens side-question history",
    )
    assert.equal(current.btw.state("session").history, true, "the card header opens side-question history")
  } finally {
    dispose()
    root.remove()
  }
}

async function close() {
  posts.length = 0
  const current = makeSession()
  start(current)
  posts.length = 0
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    click(icon(root, "Close side question"))
    await flush()
    assert.equal(current.btw.state("session").open, false, "the card header closes the side-question card")
    const message = posts.find((post) => post.type === "btwCancel") as { btwID?: string } | undefined
    assert.ok(message, "the card header cancels the running side question")
    assert.equal(message.btwID, ENTRY, "the card header cancels the running side question")
    assert.notEqual(message.btwID, THREAD, "the card header cancels the running side question")
  } finally {
    dispose()
    root.remove()
  }
}

async function history() {
  posts.length = 0
  const current = makeSession()
  current.btw.history("session")
  current.btw.handleMessage({
    type: "btwHistoryLoaded",
    sessionID: "session",
    items: [
      item({
        id: "btw_1",
        threadID: "thread-1",
        question: "first",
        status: "done",
        answer: "one",
        time: { created: 1 },
      }),
      item({ id: "btw_2", threadID: "thread-2", question: "second", status: "cancelled", time: { created: 2 } }),
    ],
  })
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    const rows = root.querySelectorAll<HTMLButtonElement>(".prompt-btw-history-item")
    assert.equal(rows.length, 2, "history mode lists the stored side questions")
    click(rows[0]!)
    await flush()
    assert.equal(current.btw.state("session").thread, "thread-1", "a history row opens its side-question thread")
    assert.equal(current.btw.state("session").history, false, "opening a history row leaves history mode")
  } finally {
    dispose()
    root.remove()
  }
}

async function failures() {
  posts.length = 0
  const current = makeSession()
  const first = start(current)
  update(current, { ...first, status: "error", error: "boom", answer: "partial", time: { created: 1, completed: 2 } })
  update(
    current,
    item({ id: "btw_2", question: "q2", status: "cancelled", answer: "partial", time: { created: 2, completed: 3 } }),
  )
  update(
    current,
    item({ id: "btw_3", question: "q3", status: "interrupted", answer: "partial", time: { created: 3, completed: 4 } }),
  )
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    const statuses = [...root.querySelectorAll(".prompt-btw-status")].map((node) => node.textContent?.trim())
    assert.deepEqual(
      statuses,
      ["Failed", "Cancelled", "Interrupted"],
      "failed, cancelled, and interrupted answers keep their status labels",
    )
    assert.equal(
      root.querySelector(".prompt-btw-error")?.textContent?.trim(),
      "boom",
      "a failed side question shows its error text",
    )
  } finally {
    dispose()
    root.remove()
  }
}

async function topError() {
  posts.length = 0
  const current = makeSession()
  current.btw.ask("session", "why?")
  const request = posts.find((message) => message.type === "btwAsk") as { requestID: string } | undefined
  assert.ok(request, "the fixture starts a side question")
  current.btw.handleMessage({ type: "btwFailed", sessionID: "session", requestID: request.requestID, error: "boom" })
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  try {
    await settle()
    assert.equal(
      root.querySelector(".prompt-btw-error")?.textContent?.trim(),
      "boom",
      "a failed side-question request shows its error text",
    )
  } finally {
    dispose()
    root.remove()
  }
}

async function copyCleanup() {
  posts.length = 0
  clipboard.length = 0
  const current = makeSession()
  finish(current)
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers: ReturnType<typeof setTimeout>[] = []
  const clears: ReturnType<typeof setTimeout>[] = []
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSet(...args)
    if (args[1] === 2000) timers.push(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    clears.push(args[0] as ReturnType<typeof setTimeout>)
    return originalClear(...args)
  }) as typeof clearTimeout
  const { root, dispose } = mount(current, { insert: () => {}, follow: () => {} })
  let live = true
  const stop = () => {
    if (!live) return
    live = false
    dispose()
    root.remove()
  }
  try {
    await settle()
    click(action(root, "Copy answer"))
    await flush()
    const timer = timers.at(-1)
    assert.ok(timer, "Copy starts a reset timer")
    stop()
    assert.ok(clears.includes(timer), "unmounting the card clears the copy reset timer")
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    stop()
  }
}

await cancel()
await actions()
await headerHistory()
await close()
await history()
await failures()
await topError()
await copyCleanup()
