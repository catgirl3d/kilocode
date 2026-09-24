// fork_change - new file
const WINDOW_MS = 250
const GROWTH = 2_048
const LIMIT = 4_000

export type Sample = { at: number; size: number; rest: string; pending?: string }

/**
 * Streaming tool progress republishes the whole output on every chunk, and each publish is written as a
 * durable part event, so a single command can copy its output into the session log hundreds of times.
 * Publishing at most once per window, or as soon as the payload grew meaningfully, keeps the live view
 * current without a copy per chunk. Successful tools publish their final state separately; errors
 * and aborts retain the latest bounded unpublished output for the terminal part.
 */
export function due(prev: Sample | undefined, next: Sample): boolean {
  if (!prev) return true
  if (prev.rest !== next.rest) return true
  if (next.at - prev.at >= WINDOW_MS) return true
  return next.size - prev.size >= GROWTH
}

/** Bound a published payload to what a live view renders, keeping the newest output. */
export function trim(text: string): string {
  if (text.length <= LIMIT) return text
  return "...\n\n" + text.slice(-LIMIT)
}

/**
 * Fingerprint of everything in a metadata update except the streamed output. Comparing it keeps the
 * throttle honest: an update that also changed a sibling key is never dropped, only pure progress is.
 */
export function rest(meta: Record<string, unknown> | undefined): string {
  if (meta === undefined) return ""
  const next = { ...meta }
  delete next.output
  return JSON.stringify(next)
}
