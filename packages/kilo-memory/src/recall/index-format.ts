import { MemoryFiles } from "../storage/store"
import { MemorySchema } from "../schema"
import { MemorySlug } from "../slug"
import type { MemoryShared } from "./shared"

/** Serializes inventory items and topic routing into the index's `record id=… / text: …` lines. */
export namespace MemoryIndexFormat {
  type Item = MemoryShared.TypedItem

  function type(section: string) {
    return MemorySchema.recordKind("project.md", section)
  }

  function rank(section: string) {
    const kind = type(section)
    if (kind === "PROJECT_DECISION") return 0
    if (kind === "PROJECT_CONSTRAINT") return 1
    if (kind === "PROJECT_FACT") return 2
    return 3
  }

  function id(input: string) {
    return MemorySlug.safe(input, { max: MemorySlug.max.record, fallback: "memory" })
  }

  function text(input: string) {
    return input.trim().replaceAll("```", "'''").replaceAll(/\s+/g, " ")
  }

  function date(input?: number | string) {
    if (typeof input === "string") return input.replaceAll(/\s+/g, "_")
    if (typeof input === "number" && Number.isFinite(input)) return new Date(input).toISOString()
    return "unknown"
  }

  // fork_change start - [fork] record() carries optional content=partial and memory_id routing markers.
  export function record(input: {
    kind: string
    id: string
    source: string
    updated?: number | string
    text: string
    content?: "partial"
    memory_id?: string
  }) {
    const markers = [
      input.content ? `content=${input.content}` : "",
      input.memory_id ? `memory_id=${input.memory_id}` : "",
    ]
      .filter(Boolean)
      .join(" ")
    // fork_change end
    return [
      // fork_change start - [fork] Insert routing markers after the record id.
      `record id=${id(input.id)}${markers ? ` ${markers}` : ""} type=${id(input.kind.toLowerCase())} source=${id(input.source)} updated=${date(input.updated)}`,
      // fork_change end
      `text: ${text(input.text)}`,
    ].join("\n")
  }

  // fork_change start - [fork] Render typed items either as previews (marked partial) or as their full text.
  function item(kind: string, entry: Item, full?: boolean) {
    const partial = !full && entry.partial
    return record({
      kind,
      id: MemoryFiles.inventoryKey({ file: entry.file, section: entry.section, key: entry.key }),
      source: entry.file,
      updated: entry.updatedAt,
      text: full ? entry.full : `${entry.key} :: ${entry.text}`,
      ...(partial ? { content: "partial" as const, memory_id: entry.memory_id } : {}),
    })
  }
  // fork_change end

  export function lines(prefix: string, items: Item[]) {
    return items.map((entry) => item(prefix, entry)) // fork_change - [fork] render through the item() helper
  }

  // One compact record mapping topics to the files holding them, so the model knows what kilo_memory_recall can find.
  export function hints(items: Item[]) {
    const rows = MemorySchema.Topics.flatMap((topic) => {
      const group = items.filter((item) => item.topics.includes(topic))
      if (group.length === 0) return []
      const files = [...new Set(group.map((item) => item.file))].sort().join(",")
      const latest = Math.max(...group.map((item) => item.updatedAt ?? 0))
      return [{ text: `topic=${topic} sources=${files} records=${group.length}`, latest }]
    })
    if (rows.length === 0) return []
    return [
      record({
        kind: "TOPIC_HINT",
        id: "topic.map",
        source: "inventory",
        updated: Math.max(...rows.map((row) => row.latest)) || "unknown",
        text: rows.map((row) => row.text).join(" | "),
      }),
    ]
  }

  // fork_change start - [fork] project() can render typed items in full.
  export function project(items: Item[], input?: { include?: string[]; exclude?: string[]; full?: boolean }) {
    // fork_change end
    const include = new Set(input?.include ?? [])
    const exclude = new Set(input?.exclude ?? [])
    return [...items]
      .filter((item) => {
        const kind = type(item.section)
        if (include.size > 0 && !include.has(kind)) return false
        return !exclude.has(kind)
      })
      .sort((a, b) => rank(a.section) - rank(b.section))
      .map((entry) => item(type(entry.section), entry, input?.full)) // fork_change
  }
}
