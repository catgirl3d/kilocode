// fork_change - new file
import { randomUUID } from "node:crypto"
import type { Memento } from "vscode"
import { SECTION_COLORS } from "../webview-ui/agent-manager/section-colors"
import type { SessionTag, SessionTagError, SessionTagsState } from "../webview-ui/src/types/messages/sessions"
import { createMementoStore } from "./memento-store"

const KEY = "sessionTags"
const COLORS = new Set<string>(SECTION_COLORS.map((color) => color.label))
const EMPTY: SessionTagsState = { tags: [], sessions: {} }
const store = createMementoStore<SessionTagsState>({
  key: KEY,
  empty: EMPTY,
  sanitize,
  copy,
})

type Change = { next?: SessionTagsState; error?: SessionTagError }

export function initSessionTags(value: Memento): void {
  store.init(value)
}

export function sessionTags(): SessionTagsState {
  return store.snapshot()
}

export function onSessionTagsChanged(listener: (state: SessionTagsState) => void): () => void {
  return store.onChange((state) => {
    try {
      listener(state)
    } catch (error) {
      console.error("[Kilo New] Session tag listener failed:", error)
    }
  })
}

export async function handleSessionTagsMessage(message: unknown, post: (message: unknown) => void): Promise<boolean> {
  if (!record(message)) return false
  if (message.type === "requestSessionTags") {
    send(post, { type: "sessionTagsLoaded", state: sessionTags() })
    return true
  }
  if (message.type !== "sessionTagAction") return false
  if (typeof message.requestID !== "string" || !message.requestID) return true
  const requestID = message.requestID
  const result: { error?: SessionTagError } = {}

  try {
    await store.write((state) => {
      const change = apply(state, message.action)
      if (change.error) {
        result.error = change.error
        return
      }
      if (!change.next) return
      return { next: change.next }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to persist session tags:", error)
    send(post, { type: "sessionTagResult", requestID, ok: false, error: "storage" })
    return true
  }
  if (result.error) {
    send(post, { type: "sessionTagResult", requestID, ok: false, error: result.error })
    return true
  }
  send(post, { type: "sessionTagResult", requestID, ok: true })
  return true
}

export async function removeSessionTags(sessionID: string): Promise<void> {
  if (!localID(sessionID)) return
  try {
    await store.write((state) => {
      if (!Object.hasOwn(state.sessions, sessionID)) return
      const sessions = { ...state.sessions }
      delete sessions[sessionID]
      const next = { ...state, sessions }
      return { next }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to remove session tags:", error)
  }
}

function create(state: SessionTagsState, action: Record<string, unknown>): Change {
  const sessionID = action.sessionID
  const name = action.name
  const color = action.color
  if (typeof sessionID !== "string" || !localID(sessionID) || typeof color !== "string" || !COLORS.has(color)) {
    return { error: "invalid" }
  }
  if (typeof name !== "string" || !name.trim()) return { error: "name" }
  const trimmed = name.trim()
  if (state.tags.some((tag) => tag.name.toLowerCase() === trimmed.toLowerCase())) return { error: "duplicate" }

  const tag = { id: randomUUID(), name: trimmed, color }
  const ids = Object.hasOwn(state.sessions, sessionID) ? state.sessions[sessionID]! : []
  const sessions = { ...state.sessions, [sessionID]: [...ids, tag.id] }
  return { next: { tags: [...state.tags, tag], sessions } }
}

function update(state: SessionTagsState, action: Record<string, unknown>): Change {
  const id = action.id
  if (typeof id !== "string") return { error: "missing" }
  const tag = state.tags.find((item) => item.id === id)
  if (!tag) return { error: "missing" }
  const raw = action.patch
  if (!record(raw) || Object.keys(raw).some((key) => key !== "name" && key !== "color")) {
    return { error: "invalid" }
  }
  const patch: Partial<Pick<SessionTag, "name" | "color">> = {}
  if (Object.hasOwn(raw, "name")) {
    if (typeof raw.name !== "string" || !raw.name.trim()) return { error: "name" }
    const name = raw.name.trim()
    if (state.tags.some((item) => item.id !== tag.id && item.name.toLowerCase() === name.toLowerCase())) {
      return { error: "duplicate" }
    }
    if (name !== tag.name) patch.name = name
  }
  if (Object.hasOwn(raw, "color")) {
    if (typeof raw.color !== "string" || !COLORS.has(raw.color)) return { error: "invalid" }
    if (raw.color !== tag.color) patch.color = raw.color
  }
  if (Object.keys(patch).length === 0) return {}
  return { next: { ...state, tags: state.tags.map((item) => (item.id === tag.id ? { ...item, ...patch } : item)) } }
}

function apply(state: SessionTagsState, action: unknown): Change {
  if (!record(action) || typeof action.type !== "string") return { error: "invalid" }
  if (action.type === "create") return create(state, action)
  if (action.type === "update") return update(state, action)
  if (action.type === "assign") {
    const sessionID = action.sessionID
    const id = action.id
    const assigned = action.assigned
    if (typeof sessionID !== "string" || !localID(sessionID) || typeof assigned !== "boolean") {
      return { error: "invalid" }
    }
    if (typeof id !== "string" || !state.tags.some((tag) => tag.id === id)) return { error: "missing" }
    const ids = Object.hasOwn(state.sessions, sessionID) ? state.sessions[sessionID]! : []
    if (assigned) {
      if (ids.includes(id)) return {}
      return { next: { ...state, sessions: { ...state.sessions, [sessionID]: [...ids, id] } } }
    }
    if (!ids.includes(id)) return {}
    const rest = ids.filter((item) => item !== id)
    const sessions = { ...state.sessions }
    if (rest.length) sessions[sessionID] = rest
    else delete sessions[sessionID]
    return { next: { ...state, sessions } }
  }
  if (action.type === "delete") {
    const id = action.id
    if (typeof id !== "string") return { error: "missing" }
    if (!state.tags.some((tag) => tag.id === id)) return { error: "missing" }
    const sessions = Object.fromEntries(
      Object.entries(state.sessions)
        .map(([sessionID, ids]) => [sessionID, ids.filter((tagID) => tagID !== id)] as const)
        .filter(([, ids]) => ids.length > 0),
    )
    return { next: { tags: state.tags.filter((tag) => tag.id !== id), sessions } }
  }
  return { error: "invalid" }
}

function sanitize(value: unknown): SessionTagsState {
  if (!record(value)) return copy(EMPTY)
  const tags: SessionTag[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const item of Array.isArray(value.tags) ? (value.tags as unknown[]) : []) {
    if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.name !== "string") continue
    if (typeof item.color !== "string" || !COLORS.has(item.color)) continue
    const name = item.name.trim()
    const key = name.toLowerCase()
    if (!name || ids.has(item.id) || names.has(key)) continue
    ids.add(item.id)
    names.add(key)
    tags.push({ id: item.id, name, color: item.color })
  }
  const sessions = Object.fromEntries(
    Object.entries(record(value.sessions) ? value.sessions : {}).flatMap(([id, value]) => {
      if (!localID(id) || !Array.isArray(value)) return []
      const assigned = [
        ...new Set(
          (value as unknown[]).filter((tagID): tagID is string => typeof tagID === "string" && ids.has(tagID)),
        ),
      ]
      return assigned.length ? [[id, assigned] as const] : []
    }),
  )
  return { tags, sessions }
}

function copy(value: SessionTagsState): SessionTagsState {
  return {
    tags: value.tags.map((tag) => ({ ...tag })),
    sessions: Object.fromEntries(Object.entries(value.sessions).map(([id, ids]) => [id, [...ids]])),
  }
}

function send(post: (message: unknown) => void, message: unknown): void {
  try {
    post(message)
  } catch (error) {
    console.error("[Kilo New] Session tag message delivery failed:", error)
  }
}

function localID(value: string): boolean {
  return value.length > 0 && !value.startsWith("cloud:")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
