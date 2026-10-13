// fork_change - new file
import { MemoryMarkerMeta } from "@kilocode/kilo-memory/marker-meta"
import type { MemoryEventDetail } from "../types/messages/memory"

const LIMIT = 50

export type MemoryActivity = {
  type: "loaded" | "recalled" | "saved"
  at: number
  tokens: number
  count: number
  items: string[]
  refs: string[]
}

export function markerActivity(parts: readonly MemoryMarkerMeta.Part[], at: number): MemoryActivity | undefined {
  const meta = MemoryMarkerMeta.fromParts(parts)
  if (!meta) return
  return {
    type: meta.type === "startup" ? "loaded" : "recalled",
    at,
    tokens: meta.tokens,
    count: meta.count,
    // fork_change start - [fork] structured recall items render as their text
    items: meta.items.map((item) => (typeof item === "string" ? item : item.text)),
    // fork_change end
    refs: meta.files,
  }
}

export function addMemoryActivity(
  items: readonly MemoryActivity[],
  detail: MemoryEventDetail,
  at: number,
): MemoryActivity[] {
  if (detail.type !== "saved") return [...items]
  const count = detail.added ?? detail.operationCount ?? 1
  if (count <= 0) return [...items]
  const item: MemoryActivity = {
    type: "saved",
    at,
    tokens: 0,
    count,
    items: detail.message ? [detail.message] : [],
    refs: [...(detail.sources ?? []), ...(detail.files ?? [])],
  }
  return [...items, item].slice(-LIMIT)
}
