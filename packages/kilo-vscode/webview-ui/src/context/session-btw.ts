// fork_change - new file
import { createStore, produce } from "solid-js/store"
import { mergeBtw } from "@opencode-ai/core/kilocode/btw/client"
import type { BtwItem, ExtensionMessage, WebviewMessage } from "../types/messages"

type BtwState = {
  items: BtwItem[]
  open: boolean
  thread?: string
  history: boolean
  focus: number
  loaded: boolean
  request?: string
  asked?: string
  retry?: string
  abandoned: string[]
  error?: string
}

const EMPTY: BtwState = {
  items: [],
  open: false,
  history: false,
  focus: 0,
  loaded: false,
  abandoned: [],
}

function upsert(value: BtwState, item: BtwItem) {
  const index = value.items.findIndex((entry) => entry.id === item.id)
  if (index === -1) {
    value.items.push(item)
    return
  }
  value.items[index] = mergeBtw(value.items[index], item)
}

function tidy(value: BtwState) {
  value.items.sort((a, b) => a.time.created - b.time.created)
}

export function createSessionBtw(deps: {
  post: (message: WebviewMessage) => void
  usage: (sessionID: string) => void
}) {
  const [store, setStore] = createStore<Record<string, BtwState>>({})

  const state = (sessionID?: string): BtwState => (sessionID ? (store[sessionID] ?? EMPTY) : EMPTY)

  const patch = (sessionID: string, fn: (value: BtwState) => void) =>
    setStore(
      produce((all) => {
        all[sessionID] ??= { ...EMPTY, items: [], abandoned: [] }
        fn(all[sessionID])
      }),
    )

  const drop = (sessionID: string) =>
    setStore(
      produce((all) => {
        delete all[sessionID]
      }),
    )

  const running = (sessionID?: string) => state(sessionID).items.some((item) => item.status === "running")

  // A pending start or a running answer blocks the next side question.
  const busy = (sessionID?: string) => !!state(sessionID).request || running(sessionID)

  // The thread the card shows; the history list and a closed card show none, so a question there starts fresh.
  const shown = (sessionID?: string) => {
    const value = state(sessionID)
    return value.open && !value.history ? value.thread : undefined
  }

  const current = (sessionID?: string) => {
    const value = state(sessionID)
    return value.thread ? value.items.filter((item) => item.threadID === value.thread) : []
  }

  // Items are kept in creation order, so the last running one is the newest.
  const cancel = (sessionID: string) => {
    const item = state(sessionID)
      .items.filter((entry) => entry.status === "running")
      .at(-1)
    if (item) deps.post({ type: "btwCancel", sessionID, btwID: item.id })
  }

  // Called before the card opens: a closed-to-open transition asks the CLI for the list, so rows it no longer
  // runs come back terminal instead of staying "running" after a missed event.
  const reconcile = (sessionID: string) => {
    if (!state(sessionID).open) deps.post({ type: "btwHistory", sessionID })
  }

  return {
    state,
    current,
    running,
    busy,
    shown,
    cancel,
    ask(sessionID: string, question: string, thread?: string) {
      // The CLI decides whether another answer is still running; a refused start comes back as btwFailed.
      const requestID = crypto.randomUUID()
      reconcile(sessionID)
      patch(sessionID, (next) => {
        next.open = true
        next.history = false
        next.request = requestID
        next.asked = question
        next.retry = undefined
        next.error = undefined
        next.focus = 0
        // A follow-up keeps its thread on screen; a fresh question drops the previous thread at once
        // and the card shows the pending state until btwStarted.
        next.thread = thread
      })
      deps.post({ type: "btwAsk", sessionID, requestID, question, threadID: thread })
    },
    // The reported session total includes /btw spend, so the cost breakdown lists it as one more line.
    breakdown(sessionID: string | undefined, items: Array<{ label: string; cost: number }>, label: string) {
      const cost = state(sessionID).items.reduce((sum, item) => sum + item.cost, 0)
      return cost > 0 ? [...items, { label, cost }] : items
    },
    open(sessionID: string, threadID: string) {
      reconcile(sessionID)
      patch(sessionID, (next) => {
        next.thread = threadID
        next.history = false
        next.open = true
        next.error = undefined
        next.focus = 0
      })
    },
    history(sessionID: string) {
      patch(sessionID, (next) => {
        next.open = true
        next.history = true
        next.error = undefined
        next.focus = 0
      })
      deps.post({ type: "btwHistory", sessionID })
    },
    compose(sessionID: string) {
      reconcile(sessionID)
      patch(sessionID, (next) => {
        next.open = true
        next.history = false
        next.error = undefined
        // A counter, not a flag: every press refocuses the card input, even when the card is already open.
        next.focus += 1
      })
    },
    // Leaves the shown thread; the next question from the card or a /btw line starts a new thread.
    fresh(sessionID: string) {
      patch(sessionID, (next) => {
        next.open = true
        next.history = false
        next.thread = undefined
        next.error = undefined
        next.retry = undefined
        next.focus += 1
      })
    },
    close(sessionID: string) {
      cancel(sessionID)
      patch(sessionID, (next) => {
        // A start can still arrive after this close; remember the request so the late answer gets cancelled.
        if (next.request) next.abandoned.push(next.request)
        next.open = false
        next.history = false
        next.thread = undefined
        next.request = undefined
        next.asked = undefined
        next.retry = undefined
        next.error = undefined
        next.focus = 0
      })
    },
    handleMessage(message: ExtensionMessage): boolean {
      if (message.type === "btwStarted") {
        const item = message.item
        const value = state(message.sessionID)
        if (value.abandoned.includes(message.requestID)) {
          deps.post({ type: "btwCancel", sessionID: message.sessionID, btwID: item.id })
          patch(message.sessionID, (next) => {
            next.abandoned = next.abandoned.filter((request) => request !== message.requestID)
          })
          return true
        }
        // The card was closed before the start came back: leave it closed.
        if (value.request !== message.requestID) return true
        patch(message.sessionID, (next) => {
          next.request = undefined
          next.asked = undefined
          next.thread = item.threadID
          upsert(next, item)
          tidy(next)
        })
        return true
      }
      if (message.type === "btwFailed") {
        const requestID = message.requestID
        if (requestID && state(message.sessionID).abandoned.includes(requestID)) {
          patch(message.sessionID, (next) => {
            next.abandoned = next.abandoned.filter((request) => request !== requestID)
          })
        }
        if (requestID && requestID !== state(message.sessionID).request) return true
        patch(message.sessionID, (next) => {
          if (requestID) {
            next.request = undefined
            // A refused start never became an item, so its question goes back to the card input.
            next.retry = next.asked
            next.asked = undefined
          }
          next.error = message.error
        })
        return true
      }
      if (message.type === "btwUpdated") {
        const item = message.item
        const before = state(message.sessionID).items.find((entry) => entry.id === item.id)?.status
        patch(message.sessionID, (next) => {
          upsert(next, item)
          tidy(next)
        })
        const after = state(message.sessionID).items.find((entry) => entry.id === item.id)?.status
        if (after === "running" || before === after) return true
        deps.usage(message.sessionID)
        return true
      }
      if (message.type === "btwHistoryLoaded") {
        const items = message.items
        patch(message.sessionID, (next) => {
          for (const item of items) upsert(next, item)
          tidy(next)
          next.loaded = true
        })
        return true
      }
      if (message.type === "sessionDeleted") {
        drop(message.sessionID)
        return false
      }
      return false
    },
  }
}
