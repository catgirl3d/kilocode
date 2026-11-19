// fork_change - new file
import { createStore, produce } from "solid-js/store"
import type { BtwItem, ExtensionMessage, WebviewMessage } from "../types/messages"

type BtwState = {
  items: BtwItem[]
  open: boolean
  thread?: string
  follow: boolean
  history: boolean
  loaded: boolean
  busy: boolean
  request?: string
  error?: string
  // The last run this panel started; closing the card cancels only that one.
  own?: string
  // The pending start's question, kept so a start the CLI refuses can hand it back.
  asked?: { question: string; thread?: string }
  retry?: { question: string; thread?: string }
}

const EMPTY: BtwState = { items: [], open: false, follow: false, history: false, loaded: false, busy: false }

// Same limit as the CLI list, so the store never keeps more records than a reload returns.
const LIMIT = 200

// Records only move forward (running -> terminal, answer grows); mirrors the TUI merge in dialog-btw.tsx.
function merge(current: BtwItem | undefined, incoming: BtwItem) {
  if (!current) return incoming
  if (current.status !== "running" && incoming.status === "running") return current
  if (current.status === "running" && incoming.status === "running" && current.answer.length > incoming.answer.length)
    return current
  return incoming
}

function upsert(value: BtwState, item: BtwItem) {
  const index = value.items.findIndex((entry) => entry.id === item.id)
  if (index === -1) {
    value.items.push(item)
    return
  }
  value.items[index] = merge(value.items[index], item)
}

function tidy(value: BtwState) {
  value.items.sort((a, b) => a.time.created - b.time.created)
  if (value.items.length > LIMIT) value.items.splice(0, value.items.length - LIMIT)
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
        all[sessionID] ??= { ...EMPTY, items: [] }
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

  const current = (sessionID?: string) => {
    const value = state(sessionID)
    // With no thread and no start pending, a running answer is still shown (e.g. after a webview reload).
    const active = value.items.filter((item) => item.status === "running").at(-1)
    const thread = value.thread ?? (value.request === undefined ? active?.threadID : undefined)
    return thread ? value.items.filter((item) => item.threadID === thread) : []
  }

  // Cancels one answer: the given one, or the last one this panel started. Another panel's run is left alone.
  const cancel = (sessionID: string, id = state(sessionID).own) => {
    const item = state(sessionID).items.find((entry) => entry.id === id && entry.status === "running")
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
    cancel,
    ask(sessionID: string, question: string) {
      const value = state(sessionID)
      // A pending start counts as running: its answer is not on the card yet, so a second ask would race it.
      if (running(sessionID) || value.request) {
        // The running row may be stale after a missed event, so the list is requested even while the card is open.
        deps.post({ type: "btwHistory", sessionID })
        const active = value.items.filter((entry) => entry.status === "running").at(-1)
        patch(sessionID, (next) => {
          next.open = true
          next.history = false
          next.busy = true
          // Brings the newest running answer into view, with its Cancel button.
          if (active) next.thread = active.threadID
        })
        return false
      }
      const requestID = crypto.randomUUID()
      const threadID = value.follow ? value.thread : undefined
      reconcile(sessionID)
      patch(sessionID, (next) => {
        next.open = true
        next.busy = false
        next.history = false
        next.follow = false
        next.request = requestID
        next.error = undefined
        // Kept so a start the CLI refuses can hand the question back.
        next.asked = { question, thread: threadID }
        // A fresh question drops the previous thread at once; the card shows the pending state until btwStarted.
        if (!threadID) next.thread = undefined
      })
      deps.post({ type: "btwAsk", sessionID, requestID, question, threadID })
      return true
    },
    follow(sessionID: string) {
      patch(sessionID, (next) => {
        next.follow = true
      })
    },
    unfollow(sessionID: string) {
      patch(sessionID, (next) => {
        next.follow = false
      })
    },
    open(sessionID: string, threadID: string) {
      reconcile(sessionID)
      patch(sessionID, (next) => {
        next.thread = threadID
        next.history = false
        next.open = true
        next.follow = false
        next.error = undefined
      })
    },
    history(sessionID: string) {
      patch(sessionID, (next) => {
        next.open = true
        next.history = true
        next.error = undefined
      })
      deps.post({ type: "btwHistory", sessionID })
    },
    // Missed bus events are never replayed, so a running row can outlive its run; only a running row needs the list.
    refresh(sessionID: string) {
      if (running(sessionID)) deps.post({ type: "btwHistory", sessionID })
    },
    close(sessionID: string) {
      cancel(sessionID)
      patch(sessionID, (next) => {
        next.open = false
        next.history = false
        next.follow = false
        next.thread = undefined
        next.request = undefined
        next.error = undefined
        next.busy = false
        next.asked = undefined
        next.retry = undefined
      })
    },
    // Hands a refused start back once; the composer restores it (see PromptInput).
    take(sessionID: string) {
      const retry = state(sessionID).retry
      if (retry) {
        patch(sessionID, (next) => {
          next.retry = undefined
        })
      }
      return retry
    },
    handleMessage(message: ExtensionMessage): boolean {
      if (message.type === "btwStarted") {
        const item = message.item
        if (state(message.sessionID).request !== message.requestID) {
          // The card closed or a newer ask superseded this start: stop the run the CLI already accepted,
          // unless an update already showed it finished.
          const status = state(message.sessionID).items.find((entry) => entry.id === item.id)?.status ?? item.status
          if (status === "running") deps.post({ type: "btwCancel", sessionID: message.sessionID, btwID: item.id })
          return true
        }
        patch(message.sessionID, (next) => {
          next.request = undefined
          next.asked = undefined
          next.own = item.id
          next.thread = item.threadID
          upsert(next, item)
          tidy(next)
        })
        return true
      }
      if (message.type === "btwFailed") {
        if (message.requestID && message.requestID !== state(message.sessionID).request) return true
        patch(message.sessionID, (next) => {
          if (message.requestID) {
            next.request = undefined
            // The CLI refused the start: its question goes back to the composer through take().
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
