import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { BtwItem } from "@/kilocode/btw/schema"
import { BtwStore } from "@/kilocode/btw/store"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))

const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const base = (sessionID: SessionID, id: string, created: number, threadID = id): BtwItem => ({
  id,
  sessionID,
  threadID,
  status: "running",
  question: `question ${id}`,
  answer: "",
  providerID: "test",
  modelID: "model",
  cost: 0,
  tokens: zero,
  time: { created },
})

describe("btw store", () => {
  it.instance("lists an inserted item as running while this process runs it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw running" })
      const item = base(session.id, "btw_running", 1_000)

      yield* BtwStore.insert(item)

      const items = yield* BtwStore.list(session.id, () => true)
      expect(items).toEqual([item])
      expect(items[0]?.status).toBe("running")
    }),
  )

  it.instance("reports a running row as interrupted when this process does not run it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw interrupted" })
      const item = base(session.id, "btw_cut", 1_000)

      yield* BtwStore.insert(item)

      const cut = yield* BtwStore.list(session.id, () => false)
      expect(cut[0]?.status).toBe("interrupted")
      const stored = yield* BtwStore.list(session.id, () => true)
      expect(stored[0]?.status).toBe("running")
    }),
  )

  it.instance("finish stores the answer and tokens and adds the cost to the session total", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "btw finish" })
      const item = base(session.id, "btw_finish", 1_000)
      const finished: BtwItem = {
        ...item,
        status: "done",
        answer: "Because the cache was cold.",
        cost: 0.25,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
        time: { created: item.time.created, completed: 2_000 },
      }

      yield* BtwStore.insert(item)
      const before = yield* db.get<{ cost: number }>(sql`SELECT cost FROM session WHERE id = ${session.id}`)
      yield* BtwStore.finish(finished)
      const after = yield* db.get<{ cost: number }>(sql`SELECT cost FROM session WHERE id = ${session.id}`)

      expect(yield* BtwStore.list(session.id, () => true)).toEqual([finished])
      expect(after?.cost).toBe((before?.cost ?? 0) + 0.25)
    }),
  )

  it.instance("a repeated finish keeps the first result and adds the cost only once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "btw refinish" })
      const item = base(session.id, "btw_refinish", 1_000)
      const finished: BtwItem = {
        ...item,
        status: "done",
        answer: "one",
        cost: 0.25,
        time: { created: item.time.created, completed: 2_000 },
      }

      yield* BtwStore.insert(item)
      const before = yield* db.get<{ cost: number }>(sql`SELECT cost FROM session WHERE id = ${session.id}`)
      yield* BtwStore.finish(finished)
      yield* BtwStore.finish({ ...finished, status: "error", answer: "two" })
      const after = yield* db.get<{ cost: number }>(sql`SELECT cost FROM session WHERE id = ${session.id}`)

      expect(after?.cost).toBe((before?.cost ?? 0) + 0.25)
      const items = yield* BtwStore.list(session.id, () => true)
      expect(items.at(0)?.status).toBe("done")
      expect(items.at(0)?.answer).toBe("one")
    }),
  )

  it.instance("thread returns only the done rows of one thread, oldest first", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw thread" })
      const first = base(session.id, "btw_first", 1_000)
      const second = base(session.id, "btw_second", 2_000, first.id)
      const other = base(session.id, "btw_other", 1_500)
      const failed = base(session.id, "btw_failed", 2_500, first.id)
      const pending = base(session.id, "btw_pending", 3_000, first.id)

      yield* BtwStore.insert(first)
      yield* BtwStore.finish({ ...first, status: "done", answer: "one", time: { created: 1_000, completed: 1_100 } })
      yield* BtwStore.insert(other)
      yield* BtwStore.finish({ ...other, status: "done", answer: "other", time: { created: 1_500, completed: 1_600 } })
      yield* BtwStore.insert(second)
      yield* BtwStore.finish({ ...second, status: "done", answer: "two", time: { created: 2_000, completed: 2_100 } })
      yield* BtwStore.insert({ ...failed, status: "error" })
      yield* BtwStore.insert(pending)

      const thread = yield* BtwStore.thread(session.id, first.id)
      expect(thread.map((item) => item.id)).toEqual([first.id, second.id])
      expect(thread.map((item) => item.status)).toEqual(["done", "done"])
      expect((yield* BtwStore.thread(session.id, other.id)).map((item) => item.id)).toEqual([other.id])
    }),
  )

  it.instance("thread replays only the last 10 done pairs, oldest first", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw thread limit" })
      for (const n of Array.from({ length: 12 }, (_, i) => i + 1)) {
        const item = base(session.id, `btw_${String(n).padStart(2, "0")}`, n * 1_000, "btw_limit")
        yield* BtwStore.insert(item)
        yield* BtwStore.finish({
          ...item,
          status: "done",
          answer: `a${n}`,
          time: { created: item.time.created, completed: item.time.created + 1 },
        })
      }

      const thread = yield* BtwStore.thread(session.id, "btw_limit")
      expect(thread.map((item) => item.answer)).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 3}`))
    }),
  )

  it.instance("list keeps insertion order for items with the same creation time", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw order" })
      for (const id of ["btw_c", "btw_a", "btw_b"]) yield* BtwStore.insert(base(session.id, id, 1_000))

      const items = yield* BtwStore.list(session.id, () => true)
      expect(items.map((item) => item.id)).toEqual(["btw_c", "btw_a", "btw_b"])
      expect(Object.keys(items[0] ?? {})).not.toContain("seq")
    }),
  )

  it.instance("ModelUsage includes the cost of a finished btw item", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "btw usage" })
      const item = base(session.id, "btw_usage", 1_000)

      yield* BtwStore.insert(item)
      expect((yield* ModelUsage.get(session.id))?.sessionCost).toBe(0)

      yield* BtwStore.finish({
        ...item,
        status: "done",
        answer: "Yes.",
        cost: 0.25,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
        time: { created: item.time.created, completed: 2_000 },
      })

      const usage = yield* ModelUsage.get(session.id)
      expect(usage?.sessionCost).toBe(0.25)
      expect(usage?.totals.cost).toBe(0.25)
      expect(usage?.totals.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } })
    }),
  )
})
