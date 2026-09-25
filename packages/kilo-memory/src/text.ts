export namespace MemoryText {
  // fork_change start - Share single-line whitespace normalization across storage and previews.
  export function normalize(input: string) {
    return input.trim().replaceAll(/\s+/g, " ")
  }
  // fork_change end

  /** Collapse internal whitespace and clip to `max` characters, appending an ellipsis when truncated. */
  export function brief(input: string, max: number) {
    const text = normalize(input) // fork_change
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(0, max - 3))}...`
  }

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
