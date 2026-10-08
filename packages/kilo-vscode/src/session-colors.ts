// fork_change - new file
import type { Memento } from "vscode"
import { createMementoStore } from "./memento-store"

const KEY = "sessionColors"

/** Persisted color labels keyed by session id. */
type SessionColors = Record<string, string>

const listeners = new Set<(colors: SessionColors) => void>()

const store = createMementoStore<SessionColors>({
  key: KEY,
  empty: {},
  sanitize,
  copy,
})

store.onChange((colors) => notify(colors))

export function initSessionColors(value: Memento): void {
  store.init(value)
}

export function sessionColors(): SessionColors {
  return store.snapshot()
}

export function onSessionColorsChanged(listener: (colors: SessionColors) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Set or clear (null) the color label for one session. */
export async function setSessionColor(sessionId: string, color: string | null): Promise<void> {
  if (!localID(sessionId)) return
  try {
    await store.write((current) => {
      if (color === null) {
        if (!Object.hasOwn(current, sessionId)) return
        const next = { ...current }
        delete next[sessionId]
        return { next }
      }
      if (!color || current[sessionId] === color) return
      return { next: { ...current, [sessionId]: color } }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to persist session colors:", error)
    notify(sessionColors())
  }
}

/** Drop the color label of a session that no longer exists. */
export async function removeSessionColor(sessionId: string): Promise<void> {
  try {
    await store.write((current) => {
      if (!Object.hasOwn(current, sessionId)) return
      const next = { ...current }
      delete next[sessionId]
      return { next }
    })
  } catch (error) {
    console.error("[Kilo New] Failed to remove session colors:", error)
    notify(sessionColors())
  }
}

function notify(colors: SessionColors): void {
  for (const listener of listeners) {
    try {
      listener(colors)
    } catch (error) {
      console.error("[Kilo New] Session color listener failed:", error)
    }
  }
}

function sanitize(value: unknown): SessionColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const colors = Object.create(null) as SessionColors
  for (const [id, color] of Object.entries(value)) {
    if (localID(id) && typeof color === "string" && color) colors[id] = color
  }
  return colors
}

function copy(value: SessionColors): SessionColors {
  return { ...value }
}

function localID(value: string): boolean {
  return value.length > 0 && !value.startsWith("cloud:")
}
