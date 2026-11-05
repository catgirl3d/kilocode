import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { KiloCompactionInternal } from "../../src/kilocode/session/compaction-internal"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

describe("internal compaction visibility", () => {
  it.instance("hides internal reasoning while keeping summaries usable", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({})
      const messages: MessageID[] = []
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const id of messages)
            yield* session.removeMessage({ sessionID: info.id, messageID: id }).pipe(Effect.ignore)
          yield* session.remove(info.id).pipe(Effect.ignore)
        }),
      )

      const parent = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: info.id,
        role: "user",
        agent: "build",
        model: { providerID, modelID },
        time: { created: Date.now() },
      })
      const base = {
        role: "assistant" as const,
        parentID: parent.id,
        sessionID: info.id,
        agent: "compaction",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens,
        modelID,
        providerID,
        time: { created: Date.now() },
      }
      const summary = {
        ...base,
        id: MessageID.ascending(),
        mode: "compaction",
        summary: true,
        finish: "stop" as const,
      } satisfies MessageV2.Assistant
      const normal = {
        ...base,
        id: MessageID.ascending(),
        mode: "build",
        agent: "build",
        summary: undefined,
        finish: "stop" as const,
      } satisfies MessageV2.Assistant
      messages.push(summary.id, normal.id)

      expect(KiloCompactionInternal.internal(summary)).toBe(true)
      expect(KiloCompactionInternal.internal(normal)).toBe(false)

      yield* session.updateMessage(summary)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: summary.id,
        sessionID: info.id,
        type: "reasoning",
        text: "internal planning",
        time: { start: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: summary.id,
        sessionID: info.id,
        type: "text",
        text: "summary",
      })
      yield* session.updateMessage(normal)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: normal.id,
        sessionID: info.id,
        type: "reasoning",
        text: "public planning",
        time: { start: Date.now() },
      })

      const visible = yield* session.messages({ sessionID: info.id })
      const kept = visible.find((message) => message.info.id === summary.id)
      expect(kept?.info.summary).toBe(true)
      expect(kept?.parts.some((part) => part.type === "reasoning")).toBe(false)
      expect(kept?.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
      const publicMessage = visible.find((message) => message.info.id === normal.id)
      expect(publicMessage?.parts.some((part) => part.type === "reasoning")).toBe(true)

      const loaded = yield* MessageV2.get({ sessionID: info.id, messageID: summary.id })
      expect(loaded.parts.some((part) => part.type === "reasoning")).toBe(false)
      expect(loaded.parts.some((part) => part.type === "text" && part.text === "summary")).toBe(true)
    }),
  )
})
