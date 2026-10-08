// fork_change - new file
import type { Memento } from "vscode"

const KEY = "sessionColors"

/** Persisted color labels keyed by session id. */
type SessionColors = Record<string, string>

let memento: Memento | undefined
const listeners = new Set<(colors: SessionColors) => void>()

export function initSessionColors(state: Memento): void {
  memento = state
}

export function sessionColors(): SessionColors {
  return validate(memento?.get(KEY))
}

export function onSessionColorsChanged(listener: (colors: SessionColors) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Set or clear (null) the color label for one session. */
export async function setSessionColor(sessionId: string, color: string | null): Promise<void> {
  const current = sessionColors()
  if (color === null) {
    if (!Object.hasOwn(current, sessionId)) return
    const next = { ...current }
    delete next[sessionId]
    await persist(next)
    return
  }
  if (!color || current[sessionId] === color) return
  await persist({ ...current, [sessionId]: color })
}

/** Drop the color label of a session that no longer exists. */
export async function removeSessionColor(sessionId: string): Promise<void> {
  const current = sessionColors()
  if (!Object.hasOwn(current, sessionId)) return
  const next = { ...current }
  delete next[sessionId]
  await persist(next)
}

async function persist(next: SessionColors): Promise<void> {
  try {
    await memento?.update(KEY, next)
    for (const listener of listeners) listener(next)
  } catch (error) {
    console.error("[Kilo New] Failed to persist session colors:", error)
    const current = sessionColors()
    for (const listener of listeners) listener(current)
  }
}

function validate(value: unknown): SessionColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const colors = Object.create(null) as SessionColors
  for (const [id, color] of Object.entries(value)) {
    if (id && typeof color === "string" && color) colors[id] = color
  }
  return colors
}
