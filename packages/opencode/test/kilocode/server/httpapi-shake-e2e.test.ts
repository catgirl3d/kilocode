import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createKiloClient } from "@kilocode/sdk/v2"
import { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { testEffect } from "../../lib/effect"
import { ProviderTest } from "../../fake/provider"
import { httpApiLayer } from "../../server/httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, Session.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function client(directory: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const base = HttpServer.formatAddress(server.address)
      return createKiloClient({
        baseUrl: "http://localhost",
        directory,
        fetch: Object.assign(
          async (request: RequestInfo | URL, init?: RequestInit) => {
            const source = request instanceof Request ? request : new Request(request, init)
            return globalThis.fetch(
              new Request(new URL(`${new URL(source.url).pathname}${new URL(source.url).search}`, base), source),
            )
          },
          { preconnect: globalThis.fetch.preconnect },
        ) satisfies typeof globalThis.fetch,
      })
    }),
  )
}

function seedTools(directory: string, sessionID: string) {
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      Session.Service.use((session) =>
        Effect.gen(function* () {
          const id = SessionID.make(sessionID)
          const message = yield* session.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "assistant",
            parentID: MessageID.ascending(),
            mode: "code",
            agent: "code",
            path: { cwd: directory, root: directory },
            modelID: ModelV2.ID.make("model"),
            providerID: ProviderV2.ID.make("provider"),
            time: { created: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } satisfies SessionV1.Assistant)

          for (const index of Array.from({ length: 8 }, (_, value) => value)) {
            yield* session.updatePart({
              id: PartID.ascending(),
              sessionID: id,
              messageID: message.id,
              type: "tool",
              callID: `call_${index}`,
              tool: "bash",
              state: {
                status: "completed",
                input: {},
                title: "bash",
                output: `tool output ${index}`,
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            })
          }
        }),
      ),
    ),
  )
}

afterEach(async () => {
  Flag.KILO_SERVER_PASSWORD = undefined
  Flag.KILO_SERVER_USERNAME = undefined
  await disposeAllInstances()
  await resetDatabase()
})

describe("shake HTTP API", () => {
  it.instance("clears eligible tool output through the generated SDK", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "shake" }))
      const sessionID = created.data!.id
      yield* seedTools(instance.directory, sessionID)

      const shaken = yield* Effect.promise(() => sdk.session.shake({ sessionID }))
      const messages = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
      const tools = messages.data!.flatMap((message) => message.parts).filter((part) => part.type === "tool")
      const stored = yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) => session.messages({ sessionID: SessionID.make(sessionID) })),
        ),
      )
      const projected = yield* Effect.promise(() => MessageV2.toModelMessages(stored, ProviderTest.model()))

      expect(shaken.response!.status).toBe(200)
      expect(shaken.error).toBeUndefined()
      expect(shaken.data?.parts).toBeGreaterThan(0)
      expect(shaken.data?.tokens).toBeGreaterThan(0)
      expect(tools).toHaveLength(8)
      expect(tools.map((part) => (part.state.status === "completed" ? part.state.time.compacted : undefined))).toEqual([
        expect.any(Number),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ])
      expect(projected).toContainEqual(expect.objectContaining({ role: "tool", content: expect.any(Array) }))
      const projectedJson = JSON.stringify(projected)
      expect(projectedJson).toContain("[Old tool result content cleared]")
      expect(projectedJson).not.toContain("tool output 0")
      expect(projectedJson).toContain("tool output 7")
    }),
  )

  it.instance("returns zero for a session without eligible output", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "empty shake" }))
      const shaken = yield* Effect.promise(() => sdk.session.shake({ sessionID: created.data!.id }))

      expect(shaken.response!.status).toBe(200)
      expect(shaken.error).toBeUndefined()
      expect(shaken.data).toMatchObject({ parts: 0, tokens: 0 })
    }),
  )
})
