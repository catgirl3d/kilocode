export namespace MemoryText {
  // fork_change start - Share single-line whitespace normalization across storage and previews.
  export function normalize(input: string) {
    return input.trim().replaceAll(/\s+/g, " ")
  }
  // fork_change end

  /** Collapse internal whitespace and clip to `max` characters, appending an ellipsis when truncated. */
  export function brief(input: string, max: number) {
    return clip(normalize(input), max) // fork_change - [fork] reuse the shared clip path
  } // fork_change - [fork] restructured brief body ends here

  // fork_change start - [fork] Code-point-safe clip for already-normalized text; prefers the last word boundary inside the limit.
  export function clip(text: string, max: number) {
    if (text.length <= max) return text
    const chars = Array.from(text)
    if (chars.length <= max) return text
    const head = chars.slice(0, Math.max(0, max - 3))
    const idx = head.lastIndexOf(" ")
    const cut = idx > 0 ? head.slice(0, idx) : head
    return `${cut.join("")}...`
  }
  // fork_change end

  /** Normalize for fuzzy matching: lowercase, NFKC, strip quotes/punctuation, collapse whitespace. */
  export function normalized(input: string) {
    return input
      .trim()
      .toLowerCase()
      .normalize("NFKC")
      .replaceAll(/[`'"“”‘’]/g, "")
      .replaceAll(/[^\p{L}\p{N}_.-]+/gu, " ")
      .replaceAll(/\s+/g, " ")
      .trim()
  }
}
