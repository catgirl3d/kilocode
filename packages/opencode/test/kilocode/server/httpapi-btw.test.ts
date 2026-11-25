import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createKiloClient } from "@kilocode/sdk/v2"
import { Bus } from "@/bus"
import { KiloBtw } from "@/kilocode/btw"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { ProviderTest } from "../../fake/provider"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { TestLLMServer, reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { httpApiLayer } from "../../server/httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const model = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("test-model"),
})
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

function get(directory: string, path: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.promise(() =>
      fetch(new URL(path, HttpServer.formatAddress(server.address)), {
        headers: { "x-kilo-directory": directory },
      }),
    ),
  )
}

// The HTTP route builds its own LLM/Provider services. Point a real provider at
// the shared TestLLMServer: the external boundary stays fake while the route
// runs its production graph.
const withHttpLlm = <A, E, R>(
  run: (input: { directory: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    return yield* run({ directory, llm }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(TestLLMServer.layer))

const originalGitlabToken = process.env.KILO_TEST_GITLAB_TOKEN

// A config-only GitLab Duo workflow provider: the real route provider builds
// its own workflow language model, which /btw must refuse before writing a row.
const gitlabConfig = {
  formatter: false,
  lsp: false,
  provider: {
    gitlab: {
      name: "GitLab",
      id: "gitlab",
      env: ["KILO_TEST_GITLAB_TOKEN"],
      npm: "gitlab-ai-provider",
      models: {
        "duo-workflow-default": {
          id: "duo-workflow-default",
          name: "Duo Workflow",
          attachment: false,
          reasoning: true,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { instanceUrl: "https://gitlab.example.com" },
    },
  },
}

const seed = Effect.fn("test.btwHttpSeed")(function* (
  sessionID: SessionID,
  ref = { providerID: model.providerID, modelID: model.id },
) {
  const sessions = yield* Session.Service
  const user = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  } satisfies SessionV1.User
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: user.id,
    type: "text",
    text: "Why is the parser slow?",
  })
  return user
})

const json = (response: Response) => Effect.promise(() => response.json()) as Effect.Effect<Record<string, unknown>>

const settled = (sessionID: SessionID, id: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const item = (yield* KiloBtw.list(sessionID)).find((row) => row.id === id)
      return item && item.status !== "running" ? item : undefined
    }),
    "side question did not settle",
  )

afterEach(async () => {
  if (originalGitlabToken === undefined) delete process.env.KILO_TEST_GITLAB_TOKEN
  else process.env.KILO_TEST_GITLAB_TOKEN = originalGitlabToken
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

  it.instance("rejects a side question before the session has a message", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw empty path" }))

      const response = yield* post(instance.directory, `/session/${created.data!.id}/btw`, { question: "why?" })
      const body = yield* json(response)

      expect(response.status).toBe(409)
      expect(body).toMatchObject({
        _tag: "ConflictError",
        message: "Send a message first, then ask a side question.",
      })
    }),
  )

  it.live("rejects a second side question while one is running", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw busy" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        yield* llm.push(reply().text("one").hang())

        const first = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "one" })
        const firstBody = yield* json(first)
        expect(first.status).toBe(200)
        expect(firstBody).toMatchObject({ status: "running" })

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "two" })
        const body = yield* json(response)

        expect(response.status).toBe(409)
        expect(body).toMatchObject({
          _tag: "ConflictError",
          message: "A side question is already running for this session.",
        })

        const cancelled = yield* Effect.promise(() =>
          sdk.session.btwCancel({ sessionID: created.data!.id, btwID: String(firstBody.id) }),
        )
        expect(cancelled.data).toEqual({ cancelled: true })
        expect((yield* settled(sessionID, String(firstBody.id))).status).toBe("cancelled")
      }),
    ),
  )

  it.instance("rejects a side question whose model cannot be resolved", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw missing model" }))
      const sessionID = SessionID.make(created.data!.id)
      yield* seed(sessionID, {
        providerID: ProviderV2.ID.make("missing"),
        modelID: ModelV2.ID.make("missing-model"),
      })

      const response = yield* post(instance.directory, `/session/${created.data!.id}/btw`, { question: "why?" })
      const body = yield* json(response)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({ _tag: "InvalidRequestError", kind: "model" })
      expect(String(body.message)).toContain("Model not found: missing/missing-model.")
    }),
  )

  it.live("starts a side question through HTTP and returns it in the list", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw http start" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        yield* llm.text("http answer")

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "how?" })
        const body = yield* json(response)

        expect(response.status).toBe(200)
        expect(body).toMatchObject({
          sessionID: created.data!.id,
          status: "running",
          question: "how?",
          answer: "",
          providerID: "test",
          modelID: "test-model",
        })
        expect(body.id).toEqual(expect.stringMatching(/^btw_/))
        expect(body.threadID).toBe(body.id)

        const listed = yield* Effect.promise(() => sdk.session.btwList({ sessionID: created.data!.id }))
        expect(listed.response!.status).toBe(200)
        expect(listed.data!.items).toEqual([
          expect.objectContaining({ id: body.id, threadID: body.id, question: "how?" }),
        ])

        const done = yield* settled(sessionID, String(body.id))
        expect(done).toMatchObject({ status: "done", answer: "http answer" })

        const after = yield* Effect.promise(() => sdk.session.btwList({ sessionID: created.data!.id }))
        expect(after.data!.items).toEqual([
          expect.objectContaining({ id: body.id, status: "done", answer: "http answer" }),
        ])
      }),
    ),
  )

  it.live("replays the earlier Q/A of a thread for an HTTP follow-up", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw http follow-up" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        yield* llm.text("first answer")

        const first = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "one" })
        const firstBody = yield* json(first)
        expect(first.status).toBe(200)
        expect((yield* settled(sessionID, String(firstBody.id))).status).toBe("done")

        yield* llm.text("second answer")
        const follow = yield* post(directory, `/session/${created.data!.id}/btw`, {
          question: "two",
          threadID: firstBody.threadID,
        })
        const followBody = yield* json(follow)
        expect(follow.status).toBe(200)
        expect(followBody).toMatchObject({ threadID: firstBody.threadID, question: "two", status: "running" })
        expect(String(followBody.id)).not.toBe(String(firstBody.id))

        const done = yield* settled(sessionID, String(followBody.id))
        expect(done).toMatchObject({ status: "done", answer: "second answer" })

        yield* llm.wait(2)
        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        const messages = inputs[1]?.messages as { role: string; content: unknown }[]
        expect(messages).toEqual(
          expect.arrayContaining([
            { role: "user", content: "Side question: one" },
            { role: "assistant", content: "first answer" },
          ]),
        )
      }),
    ),
  )

  it.live("publishes side question progress over the instance event stream", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw events" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        yield* llm.text("answer")

        const controller = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
        const events = yield* Effect.promise(() => sdk.event.subscribe(undefined, { signal: controller.signal }))
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => void (await events.stream.return?.(undefined))).pipe(Effect.ignore),
        )

        const ready = yield* Deferred.make<void>()
        const done = yield* Deferred.make<{ id: string; status: string; answer: string }>()
        const statuses: string[] = []
        yield* Effect.promise(async () => {
          for await (const event of events.stream) {
            const envelope = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>
            const payload = (envelope.payload ?? envelope) as Record<string, unknown>
            if (payload.type === "server.connected") {
              Deferred.doneUnsafe(ready, Effect.void)
              continue
            }
            if (payload.type !== KiloSessionEvent.BtwUpdated.type) continue
            const item = (payload.properties as { item: { id: string; status: string; answer: string } }).item
            statuses.push(item.status)
            if (item.status !== "done") continue
            Deferred.doneUnsafe(done, Effect.succeed(item))
            return
          }
        }).pipe(Effect.forkScoped)

        yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for the instance event stream", "5 seconds")

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "event?" })
        const body = yield* json(response)
        expect(response.status).toBe(200)
        const item = yield* awaitWithTimeout(Deferred.await(done), "timed out waiting for a btw event", "5 seconds")

        expect(statuses).toContain("running")
        expect(item).toMatchObject({ id: body.id, status: "done", answer: "answer" })
        expect((yield* settled(sessionID, String(body.id))).status).toBe("done")
      }),
    ),
  )

  it.live("starts and cancels a hanging side question through HTTP with its partial answer", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw http cancel" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        // The real route provider answers from the fake LLM over HTTP: one text chunk, then a stream that never ends.
        yield* llm.push(reply().text("partial").hang())

        const seen = yield* Deferred.make<void>()
        const off = Bus.subscribe(KiloSessionEvent.BtwUpdated, (event) => {
          if (event.properties.sessionID !== sessionID) return
          if (event.properties.item.answer !== "partial") return
          Deferred.doneUnsafe(seen, Effect.void)
        })
        yield* Effect.addFinalizer(() => Effect.sync(off))

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "cancel?" })
        const body = yield* json(response)
        expect(response.status).toBe(200)
        expect(body).toMatchObject({ status: "running", answer: "" })

        yield* awaitWithTimeout(Deferred.await(seen), "timed out waiting for the partial answer", "5 seconds")

        const cancelled = yield* Effect.promise(() =>
          sdk.session.btwCancel({ sessionID: created.data!.id, btwID: String(body.id) }),
        )
        expect(cancelled.response!.status).toBe(200)
        expect(cancelled.data).toEqual({ cancelled: true })

        const item = yield* settled(sessionID, String(body.id))
        expect(item).toMatchObject({ status: "cancelled", answer: "partial" })
      }),
    ),
  )

  it.instance("returns 404 when listing side questions in a missing session", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* get(instance.directory, "/session/ses_missing_btw/btw")

      expect(response.status).toBe(404)
    }),
  )

  it.instance("returns 404 when cancelling a side question in a missing session", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* post(instance.directory, "/session/ses_missing_btw/btw/btw_missing/cancel", {})

      expect(response.status).toBe(404)
    }),
  )

  it.instance("rejects a side question longer than 8000 characters with 400", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "btw too long" }))
      const response = yield* post(instance.directory, `/session/${created.data!.id}/btw`, {
        question: "x".repeat(8001),
      })

      expect(response.status).toBe(400)
    }),
  )

  it.live("accepts a side question of exactly 8000 characters", () =>
    withHttpLlm(({ directory, llm }) =>
      Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw max length" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID)
        yield* llm.text("long answer")

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, {
          question: "x".repeat(8000),
        })
        const body = yield* json(response)

        expect(response.status).toBe(200)
        expect(body).toMatchObject({ status: "running", question: "x".repeat(8000) })
        expect((yield* settled(sessionID, String(body.id))).status).toBe("done")
      }),
    ),
  )

  it.live("maps a GitLab Duo workflow model to the Unsupported 400", () =>
    Effect.gen(function* () {
      process.env.KILO_TEST_GITLAB_TOKEN = "kilo-test-token"
      const directory = yield* tmpdirScoped({ config: gitlabConfig })

      yield* Effect.gen(function* () {
        const sdk = yield* client(directory)
        const created = yield* Effect.promise(() => sdk.session.create({ title: "btw gitlab" }))
        const sessionID = SessionID.make(created.data!.id)
        yield* seed(sessionID, {
          providerID: ProviderV2.ID.make("gitlab"),
          modelID: ModelV2.ID.make("duo-workflow-default"),
        })

        const response = yield* post(directory, `/session/${created.data!.id}/btw`, { question: "workflow?" })
        const body = yield* json(response)

        expect(response.status).toBe(400)
        expect(body).toMatchObject({
          _tag: "InvalidRequestError",
          message: "Side questions are not available for GitLab Duo workflow models.",
        })

        const listed = yield* Effect.promise(() => sdk.session.btwList({ sessionID: created.data!.id }))
        expect(listed.data).toEqual({ items: [] })
      }).pipe(
        provideInstanceEffect(directory),
        Effect.ensuring(
          Effect.sync(() => {
            if (originalGitlabToken === undefined) delete process.env.KILO_TEST_GITLAB_TOKEN
            else process.env.KILO_TEST_GITLAB_TOKEN = originalGitlabToken
          }),
        ),
      )
    }),
  )
})
