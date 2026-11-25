import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { BtwStore } from "@/kilocode/btw/store"
import type { BtwItem } from "@/kilocode/btw/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq, sql } from "drizzle-orm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))

const ref = (providerID: string, modelID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

const seed = Effect.fn("ModelUsageTest.seed")(function* (sessionID: SessionID, model: ReturnType<typeof ref>) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 99,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
  } satisfies MessageV2.Assistant)
})

const step = Effect.fn("ModelUsageTest.step")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  model?: ReturnType<typeof ref>
  cost: number
  tokens: MessageV2.StepFinishPart["tokens"]
}) {
  const sessions = yield* Session.Service
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.messageID,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: "stop",
    model: input.model,
    cost: input.cost,
    tokens: input.tokens,
  })
})

const btw = Effect.fn("ModelUsageTest.btw")(function* (input: {
  sessionID: SessionID
  id: string
  providerID: string
  modelID: string
  cost: number
  tokens: MessageV2.StepFinishPart["tokens"]
  status?: BtwItem["status"]
}) {
  const item = {
    id: input.id,
    sessionID: input.sessionID,
    threadID: input.id,
    status: "running",
    question: `question ${input.id}`,
    answer: "",
    providerID: input.providerID,
    modelID: input.modelID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
  } satisfies BtwItem
  yield* BtwStore.insert(item)
  yield* BtwStore.finish({
    ...item,
    status: input.status ?? "done",
    answer: "Answer.",
    cost: input.cost,
    tokens: input.tokens,
    time: { created: item.time.created, completed: 2 },
  })
})

describe("session model usage", () => {
  it.instance("aggregates direct step usage by model across the top-level session tree", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const test = yield* TestInstance
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ title: "child", parentID: root.id })
      const sibling = yield* sessions.create({ title: "sibling", parentID: root.id })
      const unrelated = yield* sessions.create({ title: "unrelated" })
      const auto = ref("kilo", "kilo-auto/efficient")
      const routed = ref("kilo", "openai/gpt-5")
      const direct = ref("google", "gemini-pro")

      const rootMessage = yield* seed(root.id, auto)
      yield* step({
        sessionID: root.id,
        messageID: rootMessage.id,
        model: routed,
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
      })

      const childMessage = yield* seed(child.id, direct)
      yield* step({
        sessionID: child.id,
        messageID: childMessage.id,
        cost: 0.75,
        tokens: { input: 200, output: 40, reasoning: 15, cache: { read: 400, write: 30 } },
      })

      const siblingMessage = yield* seed(sibling.id, direct)
      yield* step({
        sessionID: sibling.id,
        messageID: siblingMessage.id,
        cost: 0.125,
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 100, write: 5 } },
      })

      const unrelatedMessage = yield* seed(unrelated.id, ref("test", "excluded"))
      yield* step({
        sessionID: unrelated.id,
        messageID: unrelatedMessage.id,
        cost: 9,
        tokens: { input: 9_000, output: 9_000, reasoning: 9_000, cache: { read: 9_000, write: 9_000 } },
      })

      const project = ProjectV2.ID.make("legacy-project")
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({
        id: project,
        worktree: AbsolutePath.make(test.directory),
        vcs: "git",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      yield* Effect.forEach([root, child, sibling], (session) =>
        db.update(SessionTable).set({ project_id: project }).where(eq(SessionTable.id, session.id)),
      )

      expect(yield* ModelUsage.get(child.id)).toEqual({
        sessionIDs: [root.id, sibling.id, child.id].sort(),
        sessionCost: 0.75,
        totals: {
          steps: 3,
          cost: 1.125,
          tokens: { input: 350, output: 70, reasoning: 20, cache: { read: 700, write: 45 } },
        },
        models: [
          {
            ...direct,
            steps: 2,
            cost: 0.875,
            tokens: { input: 250, output: 50, reasoning: 15, cache: { read: 500, write: 35 } },
          },
          {
            ...routed,
            steps: 1,
            cost: 0.25,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
          },
        ],
      })
    }),
  )

  it.instance("returns undefined for a missing session", () =>
    Effect.gen(function* () {
      expect(yield* ModelUsage.get(SessionID.make("ses_missing"))).toBeUndefined()
    }),
  )

  it.instance("scopes persisted cost to a session and its descendants, including reverted history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ title: "child", parentID: root.id })
      const sibling = yield* sessions.create({ title: "sibling", parentID: root.id })
      const grand = yield* sessions.create({ title: "grandchild", parentID: child.id })
      const model = ref("test", "model")
      for (const [session, cost] of [
        [root, 1],
        [child, 2],
        [sibling, 4],
        [grand, 8],
      ] as const) {
        const message = yield* seed(session.id, model)
        yield* step({
          sessionID: session.id,
          messageID: message.id,
          cost,
          tokens: message.tokens,
        })
      }

      expect((yield* ModelUsage.get(root.id))?.sessionCost).toBe(15)
      expect((yield* ModelUsage.get(child.id))?.sessionCost).toBe(10)
      expect((yield* ModelUsage.get(grand.id))?.sessionCost).toBe(8)
      expect((yield* ModelUsage.get(sibling.id))?.sessionCost).toBe(4)

      // Undo hides transcript rows, but does not refund their recorded spend.
      const messages = yield* sessions.messages({ sessionID: child.id })
      yield* sessions.setRevert({
        sessionID: child.id,
        revert: { messageID: messages.at(0)!.info.id },
        summary: undefined,
      })
      expect((yield* ModelUsage.get(child.id))?.sessionCost).toBe(10)
      expect((yield* ModelUsage.get(child.id))?.totals.cost).toBe(15)
    }),
  )

  it.instance("keeps usage correct when step-finish parts are inserted, updated, and deleted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "usage updates" })
      const model = ref("test", "model")
      const message = yield* seed(root.id, model)
      const empty = yield* ModelUsage.get(root.id)
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (${PartID.ascending()}, ${message.id}, ${root.id}, 1, 1, '{')`)
      const part = {
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: root.id,
        type: "step-finish",
        reason: "stop",
        cost: 0.25,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 3 } },
      } satisfies MessageV2.StepFinishPart
      yield* sessions.updatePart(part)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: root.id,
        type: "text",
        text: "Non-step output must not contribute to usage",
      })
      const usage = { steps: 1, cost: part.cost, tokens: part.tokens }
      expect(yield* ModelUsage.get(root.id)).toEqual({
        sessionIDs: [root.id],
        sessionCost: 0.25,
        totals: usage,
        models: [{ ...model, ...usage }],
      })

      const updated = { ...part, cost: 0.5, tokens: { ...part.tokens, input: 20 } }
      yield* sessions.updatePart(updated)
      const totals = { steps: 1, cost: updated.cost, tokens: updated.tokens }
      expect(yield* ModelUsage.get(root.id)).toEqual({
        sessionIDs: [root.id],
        sessionCost: 0.5,
        totals,
        models: [{ ...model, ...totals }],
      })

      // Changing the discriminator must remove and restore partial-index membership.
      yield* sessions.updatePart({
        id: part.id,
        messageID: message.id,
        sessionID: root.id,
        type: "text",
        text: "Replaced step",
      })
      expect(yield* ModelUsage.get(root.id)).toEqual(empty)
      yield* sessions.updatePart(updated)
      expect((yield* ModelUsage.get(root.id))?.totals).toEqual(totals)
      yield* sessions.removePart({ sessionID: root.id, messageID: message.id, partID: part.id })
      expect(yield* ModelUsage.get(root.id)).toEqual(empty)
    }),
  )

  it.instance("attributes finished btw spend to its own model entry across a session family", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "btw root" })
      const child = yield* sessions.create({ title: "btw child", parentID: root.id })
      const sibling = yield* sessions.create({ title: "btw sibling", parentID: root.id })
      const used = ref("test", "used")
      const side = ref("kilo", "side")

      const message = yield* seed(root.id, used)
      yield* step({
        sessionID: root.id,
        messageID: message.id,
        cost: 1,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
      })
      yield* btw({
        sessionID: child.id,
        id: "btw_child",
        providerID: "kilo",
        modelID: "side",
        cost: 0.5,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
      })
      yield* btw({
        sessionID: sibling.id,
        id: "btw_sibling",
        providerID: "kilo",
        modelID: "side",
        cost: 0.25,
        tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      })

      expect(yield* ModelUsage.get(child.id)).toEqual({
        sessionIDs: [root.id, sibling.id, child.id].sort(),
        sessionCost: 0.5,
        totals: {
          steps: 1,
          cost: 1.75,
          tokens: { input: 115, output: 26, reasoning: 8, cache: { read: 209, write: 11 } },
        },
        models: [
          {
            ...used,
            steps: 1,
            cost: 1,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 10 } },
          },
          {
            ...side,
            steps: 0,
            cost: 0.75,
            tokens: { input: 15, output: 6, reasoning: 3, cache: { read: 9, write: 1 } },
          },
        ],
      })
      // Ancestor and sibling spend stays out of the requested session's scoped cost but remains in the family totals.
      expect((yield* ModelUsage.get(root.id))?.sessionCost).toBe(1.75)
      expect((yield* ModelUsage.get(sibling.id))?.sessionCost).toBe(0.25)
    }),
  )

  it.instance("includes cancelled btw spend and excludes a running row from model usage", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const root = yield* sessions.create({ title: "btw running" })
      const side = ref("kilo", "side")
      const cancel = ref("kilo", "cancel")
      const hidden = ref("hidden", "rolled-up")

      // A running row is not spend yet, even when it already carries cost and tokens.
      yield* db.run(sql`
        INSERT INTO kilo_btw (
          id, session_id, thread_id, status, question, answer, provider_id, model_id, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created
        ) VALUES (
          'btw_unfinished', ${root.id}, 'btw_unfinished', 'running', 'still going', '',
          ${hidden.providerID}, ${hidden.modelID}, 0.5, 9000, 9000, 9000, 9000, 9000, 1
        )
      `)
      // Any terminal status spends the recorded cost; a `status = 'done'` filter would drop this row.
      yield* btw({
        sessionID: root.id,
        id: "btw_cancelled",
        providerID: "kilo",
        modelID: "cancel",
        cost: 0.5,
        tokens: { input: 20, output: 8, reasoning: 4, cache: { read: 12, write: 2 } },
        status: "cancelled",
      })
      yield* btw({
        sessionID: root.id,
        id: "btw_done",
        providerID: "kilo",
        modelID: "side",
        cost: 0.25,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
      })

      expect(yield* ModelUsage.get(root.id)).toEqual({
        sessionIDs: [root.id],
        sessionCost: 0.75,
        totals: {
          steps: 0,
          cost: 0.75,
          tokens: { input: 30, output: 12, reasoning: 6, cache: { read: 18, write: 3 } },
        },
        models: [
          {
            ...cancel,
            steps: 0,
            cost: 0.5,
            tokens: { input: 20, output: 8, reasoning: 4, cache: { read: 12, write: 2 } },
          },
          {
            ...side,
            steps: 0,
            cost: 0.25,
            tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
          },
        ],
      })
    }),
  )
})
