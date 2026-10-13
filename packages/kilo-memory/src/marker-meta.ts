export namespace MemoryMarkerMeta {
  const LIMIT = 5
  const CHARS = 120

  export type Type = "recall" | "startup"

  // fork_change start - [fork] structured recall items carry kind, key and text
  export type Kind = "fact" | "decision" | "constraint" | "correction" | "environment" | "digest" | "topics" | "other"

  export type Item = { kind: Kind; key: string; text: string }

  const KINDS: readonly string[] = [
    "fact",
    "decision",
    "constraint",
    "correction",
    "environment",
    "digest",
    "topics",
    "other",
  ]
  // fork_change end

  export type Info = {
    type: Type
    bytes: number
    tokens: number
    count: number
    files: string[]
    items: Item[] // fork_change - [fork] structured items
  }

  export type Part = {
    type: string
    metadata?: Record<string, unknown> & {
      kiloMemory?: unknown
    }
  }

  export type Decoded = {
    type: Type
    tokens: number
    count: number
    files: string[]
    items: (string | Item)[] // fork_change - [fork] legacy strings or structured items
  }

  export function metadata(marker: Info, verbose = false) {
    return {
      kiloMemory: {
        type: marker.type,
        bytes: marker.bytes,
        tokens: marker.tokens,
        count: marker.count,
        files: marker.files,
        ...(verbose && marker.type === "recall" ? { items: marker.items } : {}),
      },
    }
  }

  function header(line: string) {
    if (!line.startsWith("record ")) return
    return line
  }

  function source(line: string) {
    for (const field of line.split(" ")) {
      if (!field.startsWith("source=")) continue
      const value = field.slice("source=".length)
      if (value) return value
    }
  }

  // fork_change start - [fork] clip with a trailing ellipsis
  function clip(input: string) {
    const chars = Array.from(input)
    if (chars.length <= CHARS) return input
    return `${chars
      .slice(0, CHARS - 1)
      .join("")
      .trimEnd()}…`
  }
  // fork_change end

  // fork_change start - [fork] pair record headers with their text rows
  function field(line: string, name: string) {
    for (const part of line.split(" ")) {
      if (!part.startsWith(`${name}=`)) continue
      const value = part.slice(name.length + 1)
      if (value) return value
    }
  }

  function kindOf(input: string | undefined): Kind {
    if (!input) return "other"
    const value = input.startsWith("project_") ? input.slice("project_".length) : input
    if (value === "session_digest" || value === "latest_session_digest") return "digest"
    if (value === "env") return "environment"
    if (value === "topic_hint") return "topics"
    return KINDS.includes(value) ? (value as Kind) : "other"
  }

  function topic(value: string) {
    const match = value.match(/topic="([^"]*)"/)
    return match?.[1]
  }

  function parse(kind: Kind, value: string) {
    const idx = value.indexOf(" :: ")
    const prefix = idx >= 0 ? value.slice(0, idx).trim() : ""
    const text = clip((idx >= 0 ? value.slice(idx + 4) : value).trim())
    if (kind === "digest") return { kind, key: topic(value) ?? prefix, text }
    return { kind, key: prefix, text }
  }

  function decode(input: unknown) {
    if (typeof input === "string") return input || undefined
    if (!input || typeof input !== "object") return
    const entry = input as { kind?: unknown; key?: unknown; text?: unknown }
    if (typeof entry.kind !== "string" || !KINDS.includes(entry.kind)) return
    if (typeof entry.key !== "string" || typeof entry.text !== "string") return
    return { kind: entry.kind as Kind, key: entry.key, text: entry.text }
  }

  function list(input: readonly Item[]) {
    return input.filter((entry) => entry.text).slice(0, LIMIT)
  }
  // fork_change end

  function items(input: string) {
    // fork_change start - [fork] pair each record header with its text row
    const found: Item[] = []
    let kind: Kind = "other"
    for (const line of input.split("\n")) {
      const record = header(line)
      if (record) {
        kind = kindOf(field(record, "type"))
        continue
      }
      if (!line.startsWith("text:")) continue
      found.push(parse(kind, line.slice("text:".length).trim()))
      kind = "other"
    }
    return list(found)
    // fork_change end
  }

  export function snippets(input: Decoded | undefined, verbose: boolean) {
    if (!verbose || input?.type !== "recall") return []
    return input.items
  }

  export function fromBlocks(blocks: readonly { text: string; bytes: number; estimatedTokens: number }[]) {
    const records = blocks.flatMap((block) =>
      block.text
        .split("\n")
        .map(header)
        .filter((line) => line !== undefined),
    )
    if (records.length === 0) return
    const files = [...new Set(records.map(source).filter((file) => file !== undefined))]
    return {
      type: "startup",
      bytes: blocks.reduce((sum, block) => sum + block.bytes, 0),
      tokens: blocks.reduce((sum, block) => sum + block.estimatedTokens, 0),
      count: records.length,
      files,
      items: [],
    } satisfies Info
  }

  export function fromRecall(input: { output?: string; metadata?: Record<string, unknown>; tokens: number }) {
    const files = Array.isArray(input.metadata?.sources)
      ? input.metadata.sources.filter((file) => typeof file === "string")
      : []
    if (files.length === 0) return
    const text = input.output ?? ""
    return {
      type: "recall",
      bytes: Buffer.byteLength(text),
      tokens: input.tokens,
      count: typeof input.metadata?.count === "number" ? input.metadata.count : files.length,
      files: [...new Set(files)],
      items: items(text),
    } satisfies Info
  }

  export function fromParts(parts: readonly Part[]): Decoded | undefined {
    for (const part of parts) {
      if (part.type !== "text") continue
      const meta = part.metadata?.kiloMemory
      if (!meta || typeof meta !== "object") continue
      const value = meta as {
        type?: unknown
        tokens?: unknown
        count?: unknown
        files?: unknown
        sources?: unknown
        items?: unknown
      }
      const type = value.type === "startup" ? "startup" : "recall"
      const tokens = typeof value.tokens === "number" ? value.tokens : 0
      // `sources` fallback covers parts persisted before the key was dropped from metadata().
      const files = Array.isArray(value.files)
        ? value.files.filter((item) => typeof item === "string")
        : Array.isArray(value.sources)
          ? value.sources.filter((item) => typeof item === "string")
          : []
      const count = typeof value.count === "number" ? value.count : files.length
      // fork_change start - [fork] decode legacy string items and structured items
      const items = Array.isArray(value.items) ? value.items.flatMap((item) => decode(item) ?? []).slice(0, LIMIT) : []
      // fork_change end
      return { type, tokens, count, files, items }
    }
    return undefined
  }
}
