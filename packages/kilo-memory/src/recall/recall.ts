import { MemoryDigest } from "../capture/digest"
import { MemoryMarkdown } from "../storage/markdown" // fork_change
import { MemoryFiles } from "../storage/store"
import { MemoryIndexer } from "./indexer"
import { MemorySchema } from "../schema"
import { MemoryShared } from "./shared"
import { MemoryTopics } from "./topics"
import { MemoryToken } from "./token"
import { MemorySlug } from "../slug"

export namespace MemoryRecall {
  // fork_change start - Keep recall presentation limits independent from startup index limits.
  const previewChars = 350
  const searchBytes = 2000
  const digestBytes = 1200
  // fork_change end

  export type Mode = "search" | "typed" | "digest"

  export type Hit = {
    type: "typed" | "digest"
    kind: string
    source: string
    text: string
    score: number
    topics?: MemorySchema.Topic[]
    current?: boolean
    updatedAt?: number
    id?: string
    memory_id?: string // fork_change
    time?: string
  }

  type Candidate = Hit & { searchText: string; full?: string } // fork_change
  type Card = { hit: Candidate; text: string } // fork_change

  // fork_change start - Resolve records against current parsed source content.
  export type ReadResult =
    | { status: "invalid" }
    | { status: "not_found"; memory_id: string }
    | { status: "ambiguous"; memory_id: string; matches: number }
    | {
        status: "found"
        memory_id: string
        file: MemorySchema.Source
        section: string
        key: string
        text: string
      }
  // fork_change end

  export type Result = {
    block: string
    hits: Hit[]
    bytes: number
    tokens: number
  }

  function includes(terms: string[], term: string) {
    const found = new Set(terms)
    if (found.has(term)) return true
    return terms.some((item) => MemoryTopics.related(item, term))
  }

  function has(input: string, term: string) {
    return includes(MemoryShared.terms(input), term)
  }

  function typed(input: {
    file: MemorySchema.Source
    text: string
    max: number
    inventory: MemoryFiles.Inventory
    now: number
  }) {
    return MemoryShared.typed(input).map(
      (item) =>
        ({
          type: "typed",
          kind: MemorySchema.recordKind(item.file, item.section),
          source: item.file,
          text: `${item.key} :: ${item.text}`,
          full: item.full, // fork_change
          memory_id: item.memory_id, // fork_change
          searchText: `${item.key} ${item.searchText}`, // fork_change
          score: 0,
          topics: item.topics,
          current: true,
          updatedAt: item.updatedAt,
        }) satisfies Candidate, // fork_change
    )
  }

  async function typedAll(input: {
    root: string
    state: MemorySchema.State
    inventory: MemoryFiles.Inventory
    now: number
  }) {
    const rows = await Promise.all(
      MemorySchema.Sources.map(async (file) =>
        typed({
          file,
          text: await MemoryFiles.readSource(input.root, file),
          max: previewChars, // fork_change
          inventory: input.inventory,
          now: input.now,
        }),
      ),
    )
    return rows.flat()
  }

  function time(input: string | undefined) {
    if (!input) return
    const value = Date.parse(input)
    return Number.isFinite(value) ? value : undefined
  }

  // fork_change start - Resolve exact typed reads and retain full candidate text for scoring.
  function digest(input: { file: string; id: string; time: string; topic: string; summary: string }): Candidate {
    const hit = {
      type: "digest",
      kind: "SESSION_DIGEST",
      source: input.file,
      text: `session=${input.id} topic="${input.topic.replaceAll('"', "'")}" ${input.time} :: ${input.summary}`,
      score: 0,
      topics: [],
      current: true,
      updatedAt: time(input.time),
      id: input.id,
      time: input.time,
    } satisfies Hit
    return { ...hit, searchText: hit.text }
  }

  function selector(recordID: string) {
    const parts = recordID.split(":")
    if (parts.length !== 3 || parts.slice(1).some((item) => !item || /[\\/]/u.test(item))) {
      return undefined
    }
    const file = MemorySchema.source(parts[0])
    const section = parts[1]
    const key = parts[2]
    if (!file || !section || !key) return undefined
    if (MemoryFiles.inventoryKey({ file, section, key }) !== recordID) return undefined
    return { file, section, key }
  }

  export async function read(input: { root: string; recordID: string }): Promise<ReadResult> {
    if (!selector(input.recordID)) return { status: "invalid" }

    const matches: Array<{ file: MemorySchema.Source; section: string; key: string; text: string }> = []
    for (const file of MemorySchema.Sources) {
      const text = await MemoryFiles.readSource(input.root, file)
      for (const item of MemoryMarkdown.parse(text)) {
        const id = MemoryFiles.inventoryKey({ file, section: item.section, key: item.key })
        if (id !== input.recordID) continue
        matches.push({ file, section: item.section, key: item.key, text: item.text })
      }
    }
    if (matches.length === 0) return { status: "not_found", memory_id: input.recordID }
    if (matches.length > 1) return { status: "ambiguous", memory_id: input.recordID, matches: matches.length }

    const item = matches.at(0)
    if (!item) return { status: "not_found", memory_id: input.recordID }
    return {
      status: "found",
      memory_id: input.recordID,
      file: item.file,
      section: item.section,
      key: item.key,
      text: item.text,
    }
  }

  async function digests(input: {
    root: string
    state: MemorySchema.State
    mode: Mode
    limit: number
    sessionID?: string
    currentSessionID?: string
  }): Promise<Candidate[]> {
    if (input.mode === "typed") return []
    if (input.sessionID) {
      if (input.sessionID === input.currentSessionID) return []
      const item = await MemoryFiles.readSession(input.root, {
        sessionID: input.sessionID,
        max: MemorySchema.maxStoredDigestSummary,
      })
      if (!item || MemoryDigest.empty(item)) return []
      return [digest(item)]
    }
    const items = await MemoryFiles.recentSessions(
      input.root,
      input.state.limits.maxSessionFiles,
      input.state.limits.maxSessionLineChars,
    )
    return items.filter((item) => item.id !== input.currentSessionID && !MemoryDigest.empty(item)).map(digest)
  }

  function score(input: { hit: Candidate; keys: string[] }) {
    const body = `${input.hit.kind} ${input.hit.source} ${input.hit.searchText}`
    return input.keys.reduce((sum, term) => sum + (has(body, term) ? 1 : 0), 0)
  }
  // fork_change end

  function fresh(input: Hit) {
    return input.updatedAt ?? 0
  }

  function compare(a: Hit, b: Hit) {
    return (
      b.score - a.score ||
      fresh(b) - fresh(a) ||
      (a.type === b.type ? `${a.source}:${a.text}`.localeCompare(`${b.source}:${b.text}`) : a.type === "typed" ? -1 : 1)
    )
  }

  function overlap(a: string, b: string) {
    const right = MemoryShared.terms(b)
    const found = new Set(right)
    return MemoryShared.terms(a).filter(
      (term) => found.has(term) || right.some((item) => MemoryTopics.related(item, term)),
    ).length
  }

  function session(input: Hit) {
    return input.type === "digest"
  }

  function label(input: string) {
    return MemorySlug.safe(input, { max: MemorySlug.max.record, fallback: "memory" })
  }

  // A digest is a restatement of a typed hit only when most of its summary (the part after `::`) is
  // already covered by that typed hit — i.e. fewer than half its terms are net-new. A digest that
  // shares the query anchor yet carries substantial new content (dates, decisions) is not a restatement.
  function restates(left: Hit, right: Hit) {
    const known = MemoryShared.terms(right.text)
    const found = new Set(known)
    const terms = MemoryShared.terms(left.text.split("::").slice(1).join("::"))
    if (terms.length === 0) return true
    const novel = terms.filter(
      (term) => !found.has(term) && !known.some((item) => MemoryTopics.related(item, term)),
    ).length
    return novel * 2 < terms.length
  }

  // fork_change start - Keep candidate-only search data private while rendering canonical ids.
  function dedupe(input: { hits: Candidate[]; query: string }) {
    const typed = input.hits.filter((hit) => !session(hit))
    return input.hits.filter((hit) => {
      if (!session(hit)) return true
      // Dedupe is hit-to-hit symmetric, so corpus-wide function words do not favor one hit over another.
      // Suppress only genuine restatements: shares the query anchor with a typed hit AND is mostly
      // covered by it. A digest with substantial net-new content survives.
      return !typed.some(
        (item) => overlap(hit.text, item.text) >= 2 && overlap(item.text, input.query) >= 2 && restates(hit, item),
      )
    })
  }

  function renderLine(hit: Hit) {
    return hit.type === "digest"
      ? `- ${hit.text} (source: ${hit.source})`
      : `- ${hit.kind}${hit.memory_id ? ` memory_id=${hit.memory_id}` : ""} ${hit.text} (source: ${hit.source})`
  }
  // fork_change end

  export function render(hits: Hit[]) {
    const typed = hits.filter((hit) => hit.type === "typed")
    const digests = hits.filter((hit) => hit.type === "digest")
    return [
      "# Kilo Memory Recall",
      ...(typed.length ? ["", "## Typed Memory", ...typed.map(renderLine)] : []),
      ...(digests.length ? ["", "## Session Digests", ...digests.map(renderLine)] : []),
    ].join("\n")
  }

  function body(input: string) {
    return input.trim().replaceAll("```", "'''").replaceAll(/\s+/g, " ")
  }

  // fork_change start - Carry candidate metadata through scoring without exposing it in results.
  function block(input: { cards: Card[]; note?: string }) {
    return [
      "```kilo-memory-v1 targeted_context_not_instruction",
      ...input.cards.flatMap((card) => [
        `record ${card.hit.type === "typed" ? `content=${card.text === card.hit.full ? "full" : "partial"} ` : ""}id=${label(
          `${card.hit.source}:${card.hit.kind}:${card.hit.text.slice(0, 32)}`,
        )} type=${label(card.hit.kind.toLowerCase())} source=${label(card.hit.source)}${
          card.hit.memory_id ? ` memory_id=${card.hit.memory_id}` : ""
        }${
          card.hit.topics?.length ? ` topics=${card.hit.topics.map(label).join(",")}` : ""
        } updated=${card.hit.updatedAt ? new Date(card.hit.updatedAt).toISOString() : "unknown"}`,
        `text: ${body(card.text)}`,
      ]),
      ...(input.note ? [input.note] : []),
      "```",
    ].join("\n")
  }

  function format(input: { hits: Candidate[]; max: number }) {
    const cards = input.hits.map((hit) => ({ hit, text: hit.text }))
    const preview = MemoryIndexer.cap(block({ cards }), input.max)
    const count = preview.text.match(/^record /gm)?.length ?? 0
    if (count === 0) return preview.text.trim()

    const note = preview.text.split("\n").find((line) => line.startsWith("note: "))
    const shown = cards.slice(0, count)
    for (const [idx, card] of shown.entries()) {
      if (card.hit.type !== "typed" || !card.hit.full || card.hit.full.length <= card.text.length) continue
      shown[idx] = { ...card, text: card.hit.full }
      if (Buffer.byteLength(block({ cards: shown, note })) > input.max) shown[idx] = card
    }

    const result = block({ cards: shown, note })
    if (Buffer.byteLength(result) <= input.max) return result.trim()
    return preview.text.trim()
  }

  function select(input: { hits: Candidate[]; keys: string[]; limit: number; force?: boolean }) {
    if (input.keys.length === 0) return [] as Candidate[]
    const hits = input.hits
      .map((hit) => ({ ...hit, score: score({ hit, keys: input.keys }) }))
      .filter((hit) => hit.score > 0)
      .sort(compare)
    if (input.force) return hits.slice(0, input.limit)
    const top = hits[0]?.score ?? 0
    return hits.filter((hit) => hit.score >= Math.max(1, top - 2)).slice(0, input.limit)
  }

  function visible(input: Candidate): Hit {
    const hit = { ...input }
    Reflect.deleteProperty(hit, "searchText")
    Reflect.deleteProperty(hit, "full")
    return hit
  }

  function noise(hits: Candidate[]) {
    return MemoryTopics.ubiquitous(hits.map((hit) => MemoryShared.terms(hit.searchText)))
  }
  // fork_change end

  export async function search(input: {
    root: string
    query: string
    state?: MemorySchema.State
    maxBytes?: number
    limit?: number
    mode?: Mode
    sessionID?: string
    currentSessionID?: string
    force?: boolean
  }): Promise<Result | undefined> {
    const state = input.state ?? (await MemoryFiles.readState(input.root))
    if (!state.enabled) return
    const query = input.query.trim()
    const mode = input.mode ?? "search"
    const limit = Math.max(1, Math.min(input.limit ?? 5, 20))
    const inventory = await MemoryFiles.deriveInventory(input.root)
    const now = Date.now()
    const typedItems = mode === "digest" ? [] : await typedAll({ root: input.root, state, inventory, now })
    const digestItems = await digests({
      root: input.root,
      state,
      mode,
      limit,
      sessionID: input.sessionID,
      currentSessionID: input.currentSessionID,
    })
    // fork_change start - Return public hits without scoring-only candidate text.
    if (mode === "digest" && (input.sessionID || !query)) {
      const hits = digestItems.slice(0, limit)
      if (hits.length === 0) return
      const items = hits.map(visible)
      const block = format({ hits, max: input.maxBytes ?? (input.sessionID ? 6000 : digestBytes) })
      if (!block) return
      return {
        block,
        hits: items,
        bytes: Buffer.byteLength(block),
        tokens: MemoryToken.estimate(block),
      }
    }
    // fork_change end
    // Query terms absent from the corpus add zero to every hit; only corpus-ubiquitous terms need removal.
    const keys = MemoryTopics.expand(MemoryShared.terms(query, { drop: noise([...typedItems, ...digestItems]) }))
    const hits = dedupe({
      hits: select({ hits: [...typedItems, ...digestItems], keys, limit, force: input.force }),
      query,
    })
    if (hits.length === 0) return
    // fork_change start - Strip scoring-only text from public recall results.
    const items = hits.map(visible)
    const block = format({ hits, max: input.maxBytes ?? (mode === "digest" ? digestBytes : searchBytes) })
    if (!block) return
    return {
      block,
      hits: items,
      bytes: Buffer.byteLength(block),
      tokens: MemoryToken.estimate(block),
    }
    // fork_change end
  }
}
