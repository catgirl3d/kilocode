// fork_change - new file
import type { Memento } from "vscode"
import { createMementoStore } from "./memento-store"
import type {
  SessionFavoriteAction,
  SessionFavoriteError,
  SessionFavoritesState,
} from "../webview-ui/src/types/messages/sessions"

const KEY = "sessionFavorites"
const EMPTY: SessionFavoritesState = { sessions: [] }
const store = createMementoStore<SessionFavoritesState>({
  key: KEY,
  empty: EMPTY,
  sanitize,
  copy,
})

type Change = { next?: SessionFavoritesState; error?: SessionFavoriteError }

export function initSessionFavorites(value: Memento): void {
  store.init(value)
}

export function sessionFavorites(): SessionFavoritesState {
  return store.snapshot()
}

export function onSessionFavoritesChanged(listener: (state: SessionFavoritesState) => void): () => void {
  return store.onChange((state) => {
    try {
      listener(state)
    } catch (error) {
      console.error("[Kilo New] Session favorite listener failed:", error)
    }
  })
}

export async function handleSessionFavoritesMessage(
  message: unknown,
  post: (message: unknown) => void,
): Promise<boolean> {
  if (!record(message)) return false
  if (message.type === "requestSessionFavorites") {
    send(post, { type: "sessionFavoritesLoaded", state: sessionFavorites() })
    return true
  }
  if (message.type !== "sessionFavoriteAction") return false
  if (typeof message.requestID !== "string" || !message.requestID) return true
  const requestID = message.requestID
  const result: { error?: SessionFavoriteError } = {}

  try {
    await store.write((current) => {
      const change = apply(current, message.action)
      if (change.error) {
        result.error = change.error
        return
      }
      if (!change.next) return
      return { next: change.next }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to persist session favorites:", error)
    send(post, { type: "sessionFavoriteResult", requestID, ok: false, error: "storage" })
    return true
  }

  if (result.error) {
    send(post, { type: "sessionFavoriteResult", requestID, ok: false, error: result.error })
    return true
  }
  send(post, { type: "sessionFavoriteResult", requestID, ok: true })
  return true
}

export async function removeSessionFavorites(sessionID: string): Promise<void> {
  if (!localID(sessionID)) return
  try {
    await store.write((current) => {
      if (!current.sessions.includes(sessionID)) return
      return { next: { sessions: current.sessions.filter((id) => id !== sessionID) } }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to remove session favorites:", error)
  }
}

function apply(state: SessionFavoritesState, action: unknown): Change {
  if (!record(action) || action.type !== "set") return { error: "invalid" }
  if (typeof action.sessionID !== "string" || !localID(action.sessionID) || typeof action.favorite !== "boolean") {
    return { error: "invalid" }
  }
  const has = state.sessions.includes(action.sessionID)
  if (has === action.favorite) return {}
  const sessions = action.favorite
    ? [...state.sessions, action.sessionID]
    : state.sessions.filter((id) => id !== action.sessionID)
  return { next: { sessions } }
}

function sanitize(value: unknown): SessionFavoritesState {
  if (!record(value) || !Array.isArray(value.sessions)) return copy(EMPTY)
  const seen = new Set<string>()
  const sessions = value.sessions.filter((id): id is string => {
    if (typeof id !== "string" || !localID(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { sessions }
}

function copy(value: SessionFavoritesState): SessionFavoritesState {
  return { sessions: [...value.sessions] }
}

function send(post: (message: unknown) => void, message: unknown): void {
  try {
    post(message)
  } catch (error) {
    console.error("[Kilo New] Session favorite message delivery failed:", error)
  }
}

function localID(value: string): boolean {
  return value.length > 0 && !value.startsWith("cloud:")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
