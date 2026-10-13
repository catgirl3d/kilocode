import { MemoryBudget } from "./budget"
import { MemoryDigest } from "../capture/digest"
import { MemoryFiles } from "../storage/store"
import { MemoryIndexFormat } from "./index-format"
import { MemorySchema } from "../schema"
import { MemoryShared } from "./shared"
import { MemoryTopics } from "./topics"

export namespace MemoryIndexer {
  // Budget/envelope concerns live in MemoryBudget; re-exported here to keep MemoryIndexer.* the stable facade.
  export type Result = MemoryBudget.Result
  export const cap = MemoryBudget.cap
  export const fresh = MemoryBudget.fresh
  export const stale = MemoryBudget.stale

  type Item = MemoryShared.TypedItem
  type Digest = { id: string; topic: string; time: string; summary: string; fallback?: boolean }
  // fork_change start - A protected core section with its full rendering and a brief fail-safe preview.
  type Section = { full: string[]; preview: () => string[][] }
  // A routing group whose optional share caps how much of the routing budget it may claim greedily.
  type Group = { entries: string[][]; share?: number }
  // fork_change end

  export const digest = {
    recent: 240,
    latest(input: MemorySchema.Limits) {
      return input.maxSessionLineChars
    },
  }
  // fork_change start - [fork] Pass-2 routing keeps only the newest correction previews.
  const routing = {
    corrections: 2,
  }
  // fork_change end
  const guard = {
    covered: 32,
  }

  // fork_change start - [fork] session() can carry the latest digest in full.
  function session(input: Digest, opts: { limits: MemorySchema.Limits; latest?: boolean; full?: boolean }) {
    // fork_change end
    const topic = input.topic.replaceAll('"', "'")
    const max = opts.latest ? digest.latest(opts.limits) : digest.recent
    const summary = opts.full ? input.summary : MemoryShared.brief(input.summary, max) // fork_change
    return MemoryIndexFormat.record({
      kind: opts?.latest ? "LATEST_SESSION_DIGEST" : "SESSION_DIGEST",
      id: `${opts?.latest ? "latest_session" : "session"}.${input.id}`,
      source: `${input.id}.md`,
      updated: input.time,
      text: `session=${input.id} topic="${topic}" ${input.time}${input.fallback ? " (fallback)" : ""} :: ${summary}`,
    })
  }

  function hits(left: string[], right: string[]) {
    const found = new Set(right)
    return left.filter((item) => found.has(item) || right.some((term) => MemoryTopics.related(term, item))).length
  }

  function covered(input: { digest: Digest; items: Item[] }) {
    const label = MemoryShared.terms(input.digest.topic)
    if (label.length < 2) return false
    const detail = MemoryShared.terms(input.digest.summary)
    return input.items.some((item) => {
      const body = MemoryShared.terms(`${item.key} ${item.text}`)
      if (hits(label, body) < label.length) return false
      if (label.length >= 3) return true
      return detail.length >= 2 && hits(detail, body) >= 2
    })
  }

  function topic(input: string) {
    return input.toLowerCase().trim().replaceAll(/\s+/g, " ")
  }

  function distinct<T extends { topic: string }>(recent: T[]) {
    const topics = new Set<string>()
    return recent.filter((item) => {
      const value = topic(item.topic)
      if (!value) return true
      if (topics.has(value)) return false
      topics.add(value)
      return true
    })
  }

  // fork_change start - [fork] Deterministic two-pass composition: protected core first, routing previews fill the rest.
  function newest<T extends { updatedAt?: number }>(items: T[]) {
    return [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  function entries(records: string[]) {
    return records.map((record) => [record])
  }

  function size(chunk: string[]) {
    return chunk.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  }

  function assemble(input: {
    root: string
    limits: MemorySchema.Limits
    max: number
    core: Section[]
    routing: Group[]
  }): Result {
    const fixed = MemoryBudget.envelope({ root: input.root, limits: input.limits })
    const note = input.max >= 1024 ? Buffer.byteLength(`${MemoryBudget.note}\n`) : 0
    let left = input.max - fixed - note
    let dropped = false

    // Drop whole entries at the tail: stop at the first entry that cannot fit.
    const fill = (chunks: string[][]) => {
      const kept: string[] = []
      for (const chunk of chunks) {
        const used = size(chunk)
        if (used > left) {
          dropped = true
          break
        }
        kept.push(...chunk)
        left -= used
      }
      return kept
    }

    // A core category that alone overflows the remaining budget degrades to previews (with the
    // truncation note) instead of being dropped silently.
    const kept: string[] = []
    for (const section of input.core) {
      const used = size(section.full)
      if (used <= left) {
        kept.push(...section.full)
        left -= used
        continue
      }
      dropped = true
      kept.push(...fill(section.preview()))
    }
    // Routing groups fill in order; a group with a share may claim at most that fraction of the
    // routing budget, so a large environment block cannot starve hints and fact previews.
    const budget = left
    const cursors = input.routing.map(() => 0)
    const placed = input.routing.map(() => [] as string[])
    const take = (idx: number, cap: number) => {
      const group = input.routing[idx]
      const out = placed[idx]
      if (!group || !out) return
      let cursor = cursors[idx] ?? 0
      while (cursor < group.entries.length) {
        const chunk = group.entries[cursor]
        if (!chunk) break
        const used = size(chunk)
        if (used > cap || used > left) break
        out.push(...chunk)
        left -= used
        cap -= used
        cursor += 1
      }
      cursors[idx] = cursor
    }
    for (const [idx, group] of input.routing.entries()) {
      take(idx, group.share === undefined ? left : Math.floor(budget * group.share))
    }
    // Top-up: reclaim every unused share so a small store never wastes the reserve.
    for (const [idx, group] of input.routing.entries()) {
      if (group.share === undefined) continue
      take(idx, left)
    }
    kept.push(...placed.flat())
    if (input.routing.some((group, idx) => (cursors[idx] ?? 0) < group.entries.length)) dropped = true
    if (dropped) kept.push(MemoryBudget.note)
    const result = MemoryBudget.result({ root: input.root, limits: input.limits, lines: kept, max: input.max })
    return dropped ? { ...result, truncated: true } : result
  }
  // fork_change end

  export async function build(input: { root: string; state?: MemorySchema.State }): Promise<Result> {
    const state = input.state ?? (await MemoryFiles.readState(input.root))
    // fork_change start - [fork] Share limits across the two-pass composer.
    const limits = state.limits
    const max = limits.maxProjectIndexBytes
    // fork_change end
    const inventory = await MemoryFiles.deriveInventory(input.root)
    const correctionItems = MemoryShared.typed({
      file: "corrections.md",
      text: await MemoryFiles.readSource(input.root, "corrections.md"),
      max: state.limits.maxLineChars,
      inventory,
    })
    const projectItems = MemoryShared.typed({
      file: "project.md",
      text: await MemoryFiles.readSource(input.root, "project.md"),
      max: state.limits.maxLineChars,
      inventory,
    })
    const environmentItems = MemoryShared.typed({
      file: "environment.md",
      text: await MemoryFiles.readSource(input.root, "environment.md"),
      max: state.limits.maxLineChars,
      inventory,
    })
    const recent = await MemoryFiles.recentSessions(
      input.root,
      state.limits.maxSessionFiles,
      state.limits.maxSessionLineChars,
    )
    // fork_change start - Carry the newest digest in full: re-read its stored summary without the line clip.
    const latest = recent[0]
    const stored = latest
      ? await MemoryFiles.readSession(input.root, { sessionID: latest.id, max: MemorySchema.maxStoredDigestSummary })
      : undefined
    const current = stored ?? latest
    // fork_change end
    const ranked = newest(projectItems) // fork_change
    const all = [...correctionItems, ...projectItems, ...environmentItems]
    const durable = [...projectItems, ...environmentItems]
    const candidates = distinct(recent.slice(1).filter((item) => !MemoryDigest.empty(item)))
    const split = { uncovered: [] as typeof candidates, coveredDigests: [] as typeof candidates }
    for (const item of candidates) {
      const list = covered({ digest: item, items: durable }) ? split.coveredDigests : split.uncovered
      list.push(item)
    }
    const sessions = split.uncovered
      .slice(0, Math.max(0, limits.maxRecentSessions - (current ? 1 : 0))) // fork_change
      .map((item) => session(item, { limits })) // fork_change
    // Covered digests are dropped from the index body (their topic already lives in typed memory), but
    // their session ids stay targetable. Keep one compact pointer row so a model still knows they exist
    // and can pull the full digest by id via kilo_memory_recall mode=digest session=<id>.
    const pointer =
      split.coveredDigests.length > 0
        ? [
            MemoryIndexFormat.record({
              kind: "COVERED_SESSION_POINTER",
              id: "session.covered",
              source: "sessions",
              updated: Math.max(...split.coveredDigests.map((item) => Date.parse(item.time) || 0)) || "unknown",
              text: `covered by typed memory; recall mode=digest session=<id> :: ${split.coveredDigests
                .slice(0, guard.covered)
                .map((item) => `session=${item.id}`)
                .join(" ")}`,
            }),
          ]
        : []
    return assemble({
      root: input.root,
      limits, // fork_change
      max,
      // fork_change start - [fork] Two-pass selection: protected core, then routing previews in a fixed order.
      core: [
        {
          full: current ? [session(current, { limits, latest: true, full: true })] : [],
          preview: () => (current ? entries([session(current, { limits, latest: true })]) : []),
        },
        {
          full: MemoryIndexFormat.project(projectItems, { include: ["PROJECT_DECISION"], full: true }),
          preview: () => entries(MemoryIndexFormat.project(projectItems, { include: ["PROJECT_DECISION"] })),
        },
        {
          full: MemoryIndexFormat.project(projectItems, { include: ["PROJECT_CONSTRAINT"], full: true }),
          preview: () => entries(MemoryIndexFormat.project(projectItems, { include: ["PROJECT_CONSTRAINT"] })),
        },
      ],
      routing: [
        { entries: entries(MemoryIndexFormat.lines("ENV", newest(environmentItems))), share: 0.5 },
        { entries: entries(MemoryIndexFormat.hints(all)) },
        {
          entries: entries(MemoryIndexFormat.project(ranked, { exclude: ["PROJECT_DECISION", "PROJECT_CONSTRAINT"] })),
        },
        {
          entries: entries(
            MemoryIndexFormat.lines("CORRECTION", newest(correctionItems).slice(0, routing.corrections)),
          ),
        },
        { entries: entries(sessions) },
        { entries: entries(pointer) },
      ],
      // fork_change end
    })
  }

  export async function rebuild(input: { root: string; state?: MemorySchema.State }) {
    return MemoryFiles.queue(input.root, async () => {
      const result = await build(input)
      await MemoryFiles.writeIndex(input.root, result.text)
      return result
    })
  }
}
