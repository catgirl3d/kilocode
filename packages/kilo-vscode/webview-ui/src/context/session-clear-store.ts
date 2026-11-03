// fork_change - new file
import { createStore, produce } from "solid-js/store"
import type { useLanguage } from "./language"
import type { ReasoningClearErrorCode } from "../types/messages"

export interface ClearState {
  keepTurns: number
  requestID?: string
  previewing: boolean
  applying: boolean
  applied?: unknown
  error?: { code: ReasoningClearErrorCode; message: string }
}

export function id(): string {
  return crypto.randomUUID()
}

export function createClearStore<T extends ClearState>(options: {
  fallback: T
  keys: Record<ReasoningClearErrorCode, string>
  language: ReturnType<typeof useLanguage>
}) {
  const [store, setStore] = createStore<Record<string, T>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function state(sessionID: string): T {
    return store[sessionID] ?? options.fallback
  }

  function cancel(sessionID: string) {
    const timer = timers.get(sessionID)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(sessionID)
  }

  function drop(sessionID: string) {
    cancel(sessionID)
    setStore(
      produce((map) => {
        delete map[sessionID]
      }),
    )
  }

  function text(code: ReasoningClearErrorCode, message: string): string {
    if ((code === "unknown" || code === "conflict") && message.trim()) return message.trim()
    return options.language.t(options.keys[code])
  }

  function fail(sessionID: string, code: ReasoningClearErrorCode, message = "") {
    setStore(sessionID, {
      ...state(sessionID),
      previewing: false,
      applying: false,
      applied: undefined,
      error: { code, message: text(code, message) },
    })
  }

  function schedule(sessionID: string, delay: number, run: () => void) {
    if (delay > 0) {
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          run()
        }, delay),
      )
      return
    }
    run()
  }

  return { state, cancel, drop, fail, schedule, setStore }
}
