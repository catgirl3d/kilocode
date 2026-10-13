import { MemoryFiles } from "../storage/store"
import { MemoryIndexer } from "../recall/indexer"
import { MemoryMarkdown } from "../storage/markdown"
import { MemoryRedact } from "./redact"
import { MemoryReject } from "./reject"
import { MemorySchema } from "../schema"
import { MemoryShared } from "../recall/shared"
import { MemoryText } from "../text"
import { MemoryTopics } from "../recall/topics"
import { MemorySlug } from "../slug"

/** Low-level raw-root operation applier. Prefer the Memory facade outside package adapters. */
export namespace MemoryOperations {
  export type Add = {
    action: "add"
    file?: MemorySchema.Source
    section?: string
    key: string
    text: string
  }

  export type Remove = {
    action: "remove"
    query: string
    exact?: { file: MemorySchema.Source; section: string; key: string } // fork_change
  }

  export type Op = Add | Remove

  export type Result = {
    operationCount: number
    added: number
    removed: number
    status?: "removed" | "not_found" | "unsupported_target" // fork_change - [fork] honest outcome of a forget that removed no record
    skipped: Rejection[]
    index: MemoryIndexer.Result
  }

  // Content gating lives in MemoryReject; re-exported so MemoryOperations.reject/Rejection stay the stable surface.
  // A secret-like op is skipped (not thrown) so one redacted op cannot abort the whole batch.
  export type Rejection = MemoryReject.Rejection | { reason: "secret"; text: string }
  export const reject = MemoryReject.reject

  function key(input: string) {
    const slug = MemorySlug.safe(input.trim(), { max: MemorySlug.max.key, fallback: "", lower: true })
    if (slug) return slug
    return MemorySlug.hash(input, "memory")
  }

  export function secret(input: Add) {
    return MemoryRedact.has(input.text) || MemoryRedact.has(input.key)
  }

  // fork_change start - Persist normalized entry text independently of preview limits.
  function line(input: Add) {
    // fork_change end
    const id = key(input.key)
    const body = MemoryText.normalize(input.text) // fork_change
    if (!id) throw new Error("memory operation key is required")
    if (!body) throw new Error("memory operation text is required")
    return { key: id, text: body, line: MemoryMarkdown.line(id, body) }
  }

  type Prepared = {
    op: Add
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    line: string
  }

  function fallback(file: MemorySchema.Source | undefined) {
    if (file === "environment.md") return "Commands"
    if (file === "corrections.md") return "Corrections"
    return "Facts"
  }

  function section(input: string | undefined, file: MemorySchema.Source) {
    const clean = input
      ?.trim()
      .replaceAll(/[\x00-\x1f\x7f]+/g, " ")
      .replaceAll(/\s+/g, " ")
      .replaceAll(/^#+\s*/g, "")
      .replaceAll(/^\-\s+/g, "")
      .replaceAll(/\s+::\s+/g, " ")
      .trim()
      .slice(0, 80)
      .trim()
    return clean || fallback(file)
  }

  function heading(input: Add, file = input.file) {
    return section(input.section, file ?? "project.md")
  }

  function source(input: Add) {
    if (input.file) return input.file
    return "project.md"
  }

  /** Canonical stored id for an add op: same file/section/key normalization apply uses to write the line. */
  export function id(input: Add) {
    return `${source(input)}:${heading(input)}:${key(input.key)}`
  }

  type Selector = { id: string; file: MemorySchema.Source; section: string; key: string } // fork_change

  type Target = {
    ids: Set<string>
    items: (Selector & { text: string })[] // fork_change
    fallback?: string
    canonical?: string // fork_change
  } // fork_change

  // fork_change start - Parse exact record IDs before alias matching.
  function canonical(input: string) {
    const query = input.trim()
    const parts = query.split(":")
    const file = MemorySchema.source(parts.at(0))
    const section = parts.at(1)
    const key = parts.at(2)
    if (parts.length !== 3 || !file || !section || !key) return
    return { id: query, file, section, key } satisfies Selector
  }

  function target(input: { query: string; inventory: MemoryFiles.Inventory; preferExact?: boolean }): Target {
    // fork_change end
    const query = input.query.trim()
    // fork_change start - Resolve exact record IDs before normalized key matching.
    const record = canonical(query)
    if (record) {
      const item = input.inventory.items[record.id]
      if (!item) return { ids: new Set(), items: [], canonical: record.id }
      return {
        ids: new Set([record.id]),
        items: [{ id: record.id, file: item.file, section: item.section, key: item.key, text: item.text }],
        canonical: record.id,
      }
    }
    // fork_change end
    const slug = key(query)
    // fork_change start - Separate exact aliases from normalized fallback matches.
    const direct: Target["items"] = []
    const normalized: Target["items"] = []
    if (!query) return { ids: new Set(), items: [] }
    // fork_change end
    for (const [id, item] of Object.entries(input.inventory.items)) {
      const aliases = new Set([id, item.key, `${item.file}:${item.key}`, `${item.file}:${item.section}:${item.key}`])
      // fork_change start - Retain record identity and text during alias classification.
      const found = { id, file: item.file, section: item.section, key: item.key, text: item.text }
      if (aliases.has(query)) direct.push(found)
      else if (slug && aliases.has(slug)) normalized.push(found)
      // fork_change end
    }
    // fork_change start - Prefer exact matches and derive IDs from selected items.
    const items = input.preferExact && direct.length > 0 ? direct : [...direct, ...normalized]
    const ids = new Set(items.map((item) => item.id))
    // fork_change end
    return { ids, items, ...(ids.size === 0 ? { fallback: slug || query } : {}) }
  }

  // fork_change start - Freeze removal targets and reject ambiguous duplicate records.
  type RemoveResolution = {
    kind: "remove" | "correction"
    query: string
    items: Selector[]
    fallback?: string
  }

  function ambiguous(input: {
    kind: RemoveResolution["kind"]
    query: string
    ids: string[]
    fallback?: string
    physical?: boolean
  }) {
    const label = input.kind === "remove" ? "remove query" : "correction key"
    const mode = input.kind === "remove" ? "as query" : "as key"
    const query = input.query.length > 72 ? `${input.query.slice(0, 69)}...` : input.query
    const full = input.physical
      ? `Ambiguous memory ${label} "${query}": stored lines are duplicated; remove the duplicate lines in the memory file, then retry.`
      : `Ambiguous memory ${label} "${query}": pass one exact record id ${mode} to select the record.`
    const compact = input.physical
      ? `Ambiguous memory ${label}: stored lines are duplicated; remove the duplicate lines in the memory file, then retry.`
      : `Ambiguous memory ${label}: pass one exact record id ${mode} to select the record.`
    const mark = (count: number) => {
      const more = input.ids.length - count
      return more > 0 ? `, +${more} more` : ""
    }
    const omitted = `${input.ids.length} ids omitted (too long to display); get the memory_id with kilo_memory_recall typed/search.`
    const head = input.ids.length > 0 && full.length + " Matches: ".length + omitted.length > 240 ? compact : full
    const room = 240 - head.length - " Matches: ".length - mark(1).length
    const first = input.ids.at(0) ?? input.fallback ?? "unknown"
    if (input.ids.length > 0 && first.length > room) return `${head} Matches: ${omitted}`
    const shown = input.ids.slice(1, 5).reduce(
      (value, id) => {
        const count = value.count + 1
        const next = `${value.text}, ${id}`
        return head.length + " Matches: ".length + next.length + mark(count).length <= 240
          ? { text: next, count }
          : value
      },
      { text: first, count: 1 },
    )
    return `${head} Matches: ${shown.text}${mark(shown.count)}`
  }

  function resolveRemove(input: {
    op: Remove
    inventory: MemoryFiles.Inventory
    kind: RemoveResolution["kind"]
  }): RemoveResolution {
    if (input.op.exact) {
      return {
        kind: input.kind,
        query: input.op.query,
        items: [{ ...input.op.exact, id: MemoryFiles.inventoryKey(input.op.exact) }],
      }
    }
    const match = target({ query: input.op.query, inventory: input.inventory, preferExact: true })
    if (match.canonical && match.ids.size === 0) {
      throw new Error(`no current memory record for id "${match.canonical}"`)
    }
    return {
      kind: input.kind,
      query: input.op.query,
      items: match.items.map(({ id, file, section, key }) => ({ id, file, section, key })),
      ...(match.fallback ? { fallback: match.fallback } : {}),
    }
  }

  function physical(input: { docs: Docs; item: Selector }) {
    return MemoryMarkdown.parse(input.docs.get(input.item.file) ?? "").filter(
      (entry) =>
        MemoryFiles.inventoryKey({ file: input.item.file, section: entry.section, key: entry.key }) === input.item.id,
    ).length
  }

  function physicalFallback(input: { docs: Docs; key: string }) {
    return MemorySchema.Sources.flatMap((file) =>
      MemoryMarkdown.parse(input.docs.get(file) ?? "")
        .filter((entry) => entry.key === input.key)
        .map((entry) => ({
          id: MemoryFiles.inventoryKey({ file, section: entry.section, key: entry.key }),
          file,
          section: entry.section,
          key: entry.key,
        })),
    )
  }

  function validateRemoves(input: { docs: Docs; inventory: MemoryFiles.Inventory; removes: RemoveResolution[] }) {
    for (const remove of input.removes) {
      const ids = new Set(remove.items.map((item) => item.id))
      if (remove.fallback) {
        for (const [id, item] of Object.entries(input.inventory.items)) {
          if (item.key === remove.fallback) ids.add(id)
        }
      }
      if (ids.size > 1) {
        throw new Error(ambiguous({ kind: remove.kind, query: remove.query, ids: [...ids], fallback: remove.fallback }))
      }
      for (const item of remove.items) {
        if (physical({ docs: input.docs, item }) <= 1) continue
        throw new Error(ambiguous({ kind: remove.kind, query: remove.query, ids: [item.id], physical: true }))
      }
      if (!remove.fallback) continue
      const matches = physicalFallback({ docs: input.docs, key: remove.fallback })
      if (matches.length <= 1) continue
      throw new Error(
        ambiguous({
          kind: remove.kind,
          query: remove.query,
          ids: [...new Set(matches.map((item) => item.id))],
          fallback: remove.fallback,
          physical: true,
        }),
      )
    }
  }
  // fork_change end

  // fork_change start - Keep storage preparation separate from the display preview limit.
  function prepare(input: { state: MemorySchema.State; ops: Op[] }) {
    // fork_change end
    const skipped: Rejection[] = []
    const adds = input.ops
      .filter((item): item is Add => item.action === "add")
      // Redact rejected text too: this filter runs before the secret one, so a rejected op never
      // reaches it, and skips remain visible in the operation result.
      .filter((op) => {
        const item = reject(op)
        if (!item) return true
        skipped.push({ ...item, text: MemoryRedact.text(item.text) })
        return false
      })
      // Skip secret-like ops (record a `secret` skip) instead of throwing so the rest of the batch applies.
      .filter((op) => {
        if (!secret(op)) return true
        skipped.push({ reason: "secret", text: MemoryRedact.text(op.text) })
        return false
      })
      .map((op) => {
        const file = source(op)
        if (!(MemorySchema.Sources as readonly MemorySchema.Source[]).includes(file)) {
          throw new Error(`memory source ${file} is not valid for project`)
        }
        const section = heading(op, file)
        const item = line(op) // fork_change
        return {
          op,
          file,
          section,
          key: item.key,
          text: item.text,
          line: item.line,
        } satisfies Prepared
      })
    return { adds, skipped }
  }

  function words(input: string) {
    return MemoryShared.terms(MemoryText.normalized(input))
  }

  function similar(left: string, right: string) {
    const a = MemoryText.normalized(left)
    const b = MemoryText.normalized(right)
    if (!a || !b) return false
    if (a === b) return true
    if (Math.min(a.length, b.length) >= 24 && (a.includes(b) || b.includes(a))) return true
    const one = words(a)
    const two = words(b)
    const min = Math.min(one.length, two.length)
    if (min < 4) return false
    const overlap = one.filter((item) => two.includes(item)).length
    return overlap / min >= 0.85
  }

  function duplicate(input: { item: Prepared; inventory: MemoryFiles.Inventory }) {
    return Object.values(input.inventory.items).find(
      (item) =>
        item.file === input.item.file &&
        item.section === input.item.section &&
        (item.key === input.item.key || similar(item.text, input.item.text)),
    )
  }

  function rekey(input: { item: Prepared; key: string }) {
    return {
      ...input.item,
      key: input.key,
      line: MemoryMarkdown.line(input.key, input.item.text),
    } satisfies Prepared
  }

  function validate(input: { state: MemorySchema.State; ops: Op[] }) {
    if (!input.state.enabled) throw new Error(`${input.state.scope} memory is disabled`)
    if (input.ops.length <= input.state.capture.maxOpsPerRun) return
    throw new Error(`memory operation limit exceeded: ${input.ops.length}/${input.state.capture.maxOpsPerRun}`)
  }

  function entry(input: { item: Prepared; prior?: MemoryFiles.InventoryItem; now: number }) {
    const topics = MemoryTopics.assign({
      file: input.item.file,
      section: input.item.section,
      key: input.item.key,
      text: input.item.text,
    })
    const terms = MemoryTopics.terms({
      file: input.item.file,
      section: input.item.section,
      key: input.item.key,
      text: input.item.text,
    })
    return {
      file: input.item.file,
      section: input.item.section,
      key: input.item.key,
      text: input.item.text,
      topics,
      terms,
      createdAt: input.prior?.createdAt ?? input.now,
      updatedAt: input.now,
    } satisfies MemoryFiles.InventoryItem
  }

  // In-memory copy of every source document, edited purely before any write reaches disk.
  type Docs = Map<MemorySchema.Source, string>

  type Plan = {
    docs: Docs
    touched: Set<MemorySchema.Source>
    inventory: MemoryFiles.Inventory
    added: number
    removed: number
    count: number
  }

  // Pure: delete matching lines from the in-memory documents and drop them from the working inventory.
  // fork_change start - Consume frozen remove resolutions instead of re-resolving a mutating inventory.
  function planRemove(plan: Plan, remove: RemoveResolution) {
    // fork_change end
    for (const source of MemorySchema.Sources) {
      const next = MemoryMarkdown.remove({
        text: plan.docs.get(source) ?? "",
        // fork_change start - Apply frozen removal targets while editing documents.
        match: (item) =>
          remove.fallback === item.key ||
          remove.items.some(
            (target) => target.file === source && target.section === item.section && target.key === item.key,
          ),
        // fork_change end
      })
      if (next.count === 0) continue
      plan.docs.set(source, next.text)
      plan.touched.add(source)
      plan.removed += next.count
    }
    // fork_change start - Remove resolved record IDs from the working inventory.
    for (const item of remove.items) delete plan.inventory.items[item.id]
    if (remove.fallback) {
      // fork_change end
      for (const [id, item] of Object.entries(plan.inventory.items)) {
        if (remove.fallback === item.key) delete plan.inventory.items[id] // fork_change
      }
    }
    plan.count++
  }

  // Pure: dedupe against the working inventory, edit the in-memory document, and record the inventory entry.
  // fork_change start - Keep replacement keys stable instead of re-keying against similar corrections.
  function planAdd(plan: Plan, item: Prepared, now: number, dedupe: boolean) {
    const found = dedupe ? duplicate({ item, inventory: plan.inventory }) : undefined
    // fork_change end
    const next = found ? rekey({ item, key: found.key }) : item
    const result = MemoryMarkdown.upsert({
      text: plan.docs.get(next.file) ?? "",
      section: next.section,
      line: next.line,
    })
    if (result.changed) {
      plan.docs.set(next.file, result.text)
      plan.touched.add(next.file)
    }
    const id = MemoryFiles.inventoryKey({ file: next.file, section: next.section, key: next.key })
    const prior = plan.inventory.items[id]
    if (!result.changed && prior) return
    plan.inventory.items[id] = entry({ item: next, prior, now })
    plan.added++
    plan.count++
  }

  // Pure: sequence removes-then-adds over the loaded documents and inventory, yielding the edits to persist.
  function planOps(input: {
    docs: Docs
    inventory: MemoryFiles.Inventory
    removes: RemoveResolution[] // fork_change
    adds: Prepared[]
    now: number
    dedupe: boolean // fork_change
  }): Plan {
    const plan: Plan = {
      docs: input.docs,
      touched: new Set(),
      inventory: input.inventory,
      added: 0,
      removed: 0,
      count: 0,
    }
    for (const op of input.removes) planRemove(plan, op)
    for (const item of input.adds) planAdd(plan, item, input.now, input.dedupe) // fork_change
    return plan
  }

  async function readDocs(root: string): Promise<Docs> {
    const docs: Docs = new Map()
    for (const source of MemorySchema.Sources) docs.set(source, await MemoryFiles.readSource(root, source))
    return docs
  }

  async function writeDocs(input: { root: string; plan: Plan }) {
    for (const source of input.plan.touched) {
      await MemoryFiles.writeSource(input.root, source, input.plan.docs.get(source) ?? "")
    }
  }

  async function persist(input: { root: string; state: MemorySchema.State; count: number }) {
    const index = await MemoryIndexer.rebuild({ root: input.root, state: input.state })
    await MemoryFiles.writeState(input.root, {
      ...input.state,
      stats: {
        ...input.state.stats,
        lastOperationCount: input.count,
      },
    })
    return index
  }

  /** Resolve an auto-capture batch into safe-to-apply adds plus the removes worth honoring.
   * - adds pass through (an upsert on an existing key updates it in place during apply);
   * - a remove superseded by a same-batch add on the same key is dropped (the add already updates it);
   * - a remove whose query exactly matches an existing entry key/id is kept (bounded, auditable);
   * - any fuzzy remove that matches no existing key is dropped (hard removes stay explicit-only). */
  export function reconcile(input: { ops: Op[]; keys: Iterable<string> }): { ops: Add[]; removes: Remove[] } {
    const keys = new Set(input.keys)
    const adds = input.ops.filter((item): item is Add => item.action === "add")
    const superseded = new Set<string>()
    for (const add of adds) {
      if (add.key) superseded.add(add.key.trim())
      if (add.file) superseded.add(`${add.file}:${add.section ?? ""}:${add.key.trim()}`)
    }
    const seen = new Set<string>()
    const removes: Remove[] = []
    for (const item of input.ops) {
      if (item.action !== "remove") continue
      const query = item.query.trim()
      if (!query || seen.has(query)) continue
      if (superseded.has(query)) continue
      if (!keys.has(query)) continue
      seen.add(query)
      removes.push({ action: "remove", query })
    }
    return { ops: adds, removes }
  }

  // fork_change start - Resolve and apply corrections in the shared queued plan.
  async function execute(input: { root: string; ops: Op[]; correction?: string }) {
    // fork_change end
    return MemoryFiles.queue(input.root, async () => {
      // Load (IO): state, working inventory, and every source document.
      const state = await MemoryFiles.readState(input.root)
      validate({ state, ops: input.ops })
      const inventory = await MemoryFiles.deriveInventory(input.root)
      const docs = await readDocs(input.root)
      // fork_change start - Validate correction target uniqueness before planning operations.
      const match =
        input.correction === undefined ? undefined : target({ query: input.correction, inventory, preferExact: true })
      if (match?.canonical && match.ids.size === 0) {
        throw new Error(`no current memory record for id "${match.canonical}"`)
      }
      if (match && match.ids.size > 1) {
        throw new Error(ambiguous({ kind: "correction", query: input.correction ?? "", ids: [...match.ids] }))
      }
      // fork_change end
      // Plan (pure): validate/normalize ops, then dedupe + edit documents + update inventory in memory.
      const prepared = prepare({ state, ops: input.ops }) // fork_change
      const removes = input.ops.filter((item): item is Remove => item.action === "remove")
      // fork_change start - Replace matched corrections without creating duplicate records.
      const item = prepared.adds.at(0)
      const found = match?.ids.size === 1 ? match.items.at(0) : undefined
      const unchanged =
        item &&
        found?.file === "corrections.md" &&
        found.section === "Corrections" &&
        found.key === item.key &&
        found.text === item.text
      if (match?.ids.size === 1 && item && found && !unchanged) {
        prepared.adds[0] = rekey({ item, key: found.key })
        removes.push({
          action: "remove",
          query: found.id,
          exact: { file: found.file, section: found.section, key: found.key },
        })
      }
      const resolved = removes.map((op) =>
        resolveRemove({ op, inventory, kind: input.correction === undefined ? "remove" : "correction" }),
      )
      validateRemoves({ docs, inventory, removes: resolved })
      const plan = planOps({
        docs,
        inventory,
        removes: unchanged ? [] : resolved,
        adds: unchanged ? [] : prepared.adds,
        now: Date.now(),
        dedupe: match?.ids.size !== 1,
      })
      // fork_change end
      // Commit (IO): write changed documents, then rebuild the index and persist state.
      await writeDocs({ root: input.root, plan })
      const index = await persist({ root: input.root, state, count: plan.count })
      // fork_change start - [fork] classify a forget that removed nothing instead of reporting a silent success
      const status = await forgetStatus({ root: input.root, ops: input.ops, removed: plan.removed })
      // fork_change end
      return {
        operationCount: plan.count,
        added: plan.added,
        removed: plan.removed,
        skipped: prepared.skipped,
        index,
        ...(status ? { status } : {}), // fork_change - [fork] optional so other operation results keep their shape
      } satisfies Result
    })
  }

  // fork_change start - Resolve and apply corrections in the shared queued plan.
  export function apply(input: { root: string; ops: Op[] }) {
    return execute(input)
  }

  export function correct(input: { root: string; query: string; add: Add }) {
    return execute({ root: input.root, ops: [input.add], correction: input.query })
  }
  // fork_change end

  export async function forget(input: { root: string; query: string }) {
    return apply({ root: input.root, ops: [{ action: "remove", query: input.query }] })
  }

  // fork_change start - [fork] report a lone remove that matched nothing: a miss, or a session digest target.
  async function forgetStatus(input: { root: string; ops: Op[]; removed: number }): Promise<Result["status"]> {
    const first = input.ops.at(0)
    if (input.ops.length !== 1 || first == null || first.action !== "remove") return
    if (input.removed > 0) return "removed"
    const text = first.query.trim()
    const candidate = text.startsWith("session=") ? text.slice("session=".length).trim() : text
    if (!candidate) return "not_found"
    const digest = await MemoryFiles.readSession(input.root, {
      sessionID: candidate,
      max: MemorySchema.maxStoredDigestSummary,
    })
    return digest ? "unsupported_target" : "not_found"
  }
  // fork_change end
}
