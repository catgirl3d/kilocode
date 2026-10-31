// fork_change - new file
import { createStore, produce } from "solid-js/store"
import type { BrowserFeedbackData } from "../../../src/shared/browser-feedback"
import type { CodeContext } from "../../../src/shared/code-context"
import type { ReviewMessageData } from "../../../src/shared/review-comments"
import type { FileAttachment, SessionStatus } from "../types/messages"

export type DeferredSendInput = {
  sessionID: string
  text: string
  draft: string
  preview: string
  files?: FileAttachment[]
  review?: ReviewMessageData
  browserFeedback?: BrowserFeedbackData
  contexts?: CodeContext[]
  context?: string
}

export type DeferredSend = DeferredSendInput & { id: string }

export function createDeferredSends(deps: {
  status: (sessionID: string) => SessionStatus
  send: (item: DeferredSend) => boolean
}) {
  const [items, setItems] = createStore<Record<string, DeferredSend[]>>({})
  const [closed, setClosed] = createStore<Record<string, boolean>>({})
  const list = (sessionID?: string) => (sessionID ? (items[sessionID] ?? []) : [])
  const add = (input: DeferredSendInput) => {
    const id = crypto.randomUUID()
    setItems(input.sessionID, (current = []) => [...current, { ...input, id }])
    return true
  }
  const remove = (sessionID: string, id: string) =>
    setItems(
      produce((state) => {
        const current = state[sessionID]
        if (!current) return
        const next = current.filter((item) => item.id !== id)
        if (next.length > 0) state[sessionID] = next
        else delete state[sessionID]
      }),
    )
  const clear = (sessionID: string) => {
    setItems(
      produce((state) => {
        delete state[sessionID]
      }),
    )
    setClosed(
      produce((state) => {
        delete state[sessionID]
      }),
    )
  }
  const take = (sessionID: string) => {
    const current = items[sessionID] ?? []
    if (current.length > 0) clear(sessionID)
    return [...current]
  }
  const send = (sessionID: string, item: DeferredSend) => {
    remove(sessionID, item.id)
    if (deps.send(item)) return
    setItems(sessionID, (current = []) => [{ ...item }, ...current])
  }
  const flush = (sessionID: string) => {
    const item = items[sessionID]?.[0]
    if (!item || !closed[sessionID]) return
    if (deps.status(sessionID) !== "idle") return
    send(sessionID, item)
  }
  const turnClosed = (sessionID: string) => {
    setClosed(sessionID, true)
    flush(sessionID)
  }
  const turnBusy = (sessionID: string) =>
    setClosed(
      produce((state) => {
        delete state[sessionID]
      }),
    )
  const release = (sessionID: string, id: string) => {
    const item = items[sessionID]?.find((entry) => entry.id === id)
    if (item) send(sessionID, item)
  }
  return { list, add, cancel: remove, clear, take, turnClosed, turnBusy, flush, release }
}
