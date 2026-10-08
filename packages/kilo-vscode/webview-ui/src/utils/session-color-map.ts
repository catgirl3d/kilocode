// fork_change - new file
/**
 * Apply a color label to a session map, or remove the entry when the color is
 * null/empty. Returns the same map when nothing changes so signal consumers can
 * skip re-rendering.
 */
export function withSessionColor(
  colors: Record<string, string>,
  sessionId: string,
  color: string | null,
): Record<string, string> {
  if (!color) {
    if (!Object.hasOwn(colors, sessionId)) return colors
    const next = { ...colors }
    delete next[sessionId]
    return next
  }
  if (colors[sessionId] === color) return colors
  return { ...colors, [sessionId]: color }
}
