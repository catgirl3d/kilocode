import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Session.node, SessionProjector.node, Database.node]), []))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const withSession = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.acquireRelease(Session.use.create(input), (created) => Session.use.remove(created.id).pipe(Effect.ignore))

describe("stored message diffs", () => {
  it.instance(
    "drops patches no reader keeps and keeps the rest",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const session = yield* withSession({ title: "diff-storage" })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [
              {
                file: "big.ts",
                additions: 1,
                deletions: 0,
                status: "modified",
                patch: "x".repeat(Snapshot.MAX_DIFF_SIZE + 1),
              },
              { file: "small.ts", additions: 1, deletions: 0, status: "modified", patch: "small patch" },
            ],
          },
        } satisfies SessionV1.User)

        const { db } = yield* Database.Service
        const row = yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get().pipe(Effect.orDie)
        const summary = row?.data.summary
        const diffs = summary && typeof summary === "object" && "diffs" in summary ? (summary.diffs ?? []) : []
        expect(diffs.map((diff) => ({ file: diff.file, patch: diff.patch }))).toEqual([
          { file: "big.ts", patch: "" },
          { file: "small.ts", patch: "small patch" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
