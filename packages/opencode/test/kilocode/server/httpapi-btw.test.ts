import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createKiloClient } from "@kilocode/sdk/v2"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { testEffect } from "../../lib/effect"
import { httpApiLayer } from "../../server/httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    FSUtil.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    Database.node,
    Session.node,
    SessionStatus.node,
  ]),
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

function post(directory: string, path: string, body: Record<string, unknown>) {
  return HttpServer.HttpServer.use((server) =>
    Effect.promise(() =>
      fetch(new URL(path, HttpServer.formatAddress(server.address)), {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": directory },
        body: JSON.stringify(body),
      }),
    ),
  )
}

afterEach(async () => {
  Flag.KILO_SERVER_PASSWORD = undefined
  Flag.KILO_SERVER_USERNAME = undefined
  await disposeAllInstances()
  await resetDatabase()
})

describe("btw HTTP API", () => {
  it.instance("lists no side questions for a fresh session through the generated SDK", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw list" }))
      const listed = yield* Effect.promise(() => sdk.session.btwList({ sessionID: created.data!.id }))

      expect(listed.response!.status).toBe(200)
      expect(listed.data).toEqual({ items: [] })
    }),
  )

  it.instance("reports nothing cancelled for an unknown side question id", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw cancel" }))
      const cancelled = yield* Effect.promise(() =>
        sdk.session.btwCancel({ sessionID: created.data!.id, btwID: "btw_missing" }),
      )

      expect(cancelled.response!.status).toBe(200)
      expect(cancelled.data).toEqual({ cancelled: false })
    }),
  )

  it.instance("returns 404 when asking a side question in a missing session", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* post(instance.directory, "/session/ses_missing_btw/btw", { question: "what changed?" })

      expect(response.status).toBe(404)
    }),
  )

  it.instance("rejects an empty side question with 400", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw empty" }))
      const response = yield* post(instance.directory, `/session/${created.data!.id}/btw`, { question: "" })

      expect(response.status).toBe(400)
    }),
  )

  it.instance("rejects a whitespace-only side question with 400", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw blank" }))
      const response = yield* post(instance.directory, `/session/${created.data!.id}/btw`, { question: "   " })
      const body = yield* Effect.promise(() => response.json())

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ _tag: "InvalidRequestError", message: "The side question is empty." })
    }),
  )
})
