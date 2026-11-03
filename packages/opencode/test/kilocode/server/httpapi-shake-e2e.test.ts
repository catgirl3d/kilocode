import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createKiloClient } from "@kilocode/sdk/v2"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { testEffect } from "../../lib/effect"
import { ProviderTest } from "../../fake/provider"
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

function seedReasoning(directory: string, sessionID: string, metadata?: Record<string, unknown>) {
  return InstanceStore.Service.use((store) =>
    store.provide(
      { directory },
      Session.Service.use((session) =>
        Effect.gen(function* () {
          const id = SessionID.make(sessionID)
          const old = yield* session.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            agent: "code",
            model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
            time: { created: Date.now() },
          } satisfies SessionV1.User)
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: old.id,
            type: "text",
            text: "old turn",
          })
          const reply = yield* session.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "assistant",
            parentID: old.id,
            mode: "code",
            agent: "code",
            path: { cwd: directory, root: directory },
            modelID: ModelV2.ID.make("model"),
            providerID: ProviderV2.ID.make("provider"),
            time: { created: Date.now() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          } satisfies SessionV1.Assistant)
          const part = yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: reply.id,
            type: "reasoning",
            text: "old reasoning",
            time: { start: 1, end: 2 },
            ...(metadata ? { metadata } : {}),
          })
          const current = yield* session.updateMessage({
            id: MessageID.ascending(),
            sessionID: id,
            role: "user",
            agent: "code",
            model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
            time: { created: Date.now() },
          } satisfies SessionV1.User)
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: id,
            messageID: current.id,
            type: "text",
            text: "current turn",
          })
          return part.id
        }),
      ),
    ),
  )
}

function body(response: Response) {
  return Effect.promise(() => response.json() as Promise<Record<string, unknown>>)
}

function ready(directory: string, title: string) {
  return Effect.gen(function* () {
    const sdk = yield* client(directory)
    const created = yield* Effect.promise(() => sdk.session.create({ title }))
    const id = created.data!.id
    yield* seedReasoning(directory, id)
    const preview = yield* body(yield* post(directory, `/session/${id}/reasoning/clear/preview`, { keepTurns: 1 }))
    return { id, token: String(preview.token) }
  })
}

function rejects(directory: string, id: string, token: string, tag: string) {
  return Effect.gen(function* () {
    const preview = yield* post(directory, `/session/${id}/reasoning/clear/preview`, { keepTurns: 1 })
    expect(preview.status).toBe(409)
    expect(yield* body(preview)).toMatchObject({ _tag: tag })
    const apply = yield* post(directory, `/session/${id}/reasoning/clear`, { keepTurns: 1, token })
    expect(apply.status).toBe(409)
    expect(yield* body(apply)).toMatchObject({ _tag: tag })
  })
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

  it.instance("previews without writes and applies reasoning clear through HTTP", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "reasoning clear" }))
      const sessionID = created.data!.id
      yield* seedReasoning(instance.directory, sessionID)

      const before = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
      const previewResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, {
        keepTurns: 1,
      })
      const preview = yield* body(previewResponse)
      const afterPreview = yield* Effect.promise(() => sdk.session.messages({ sessionID }))

      expect(previewResponse.status).toBe(200)
      expect(preview).toMatchObject({ turns: 1, parts: 1, tokens: expect.any(Number) })
      expect(afterPreview.data).toEqual(before.data)

      const applyResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear`, {
        keepTurns: 1,
        token: String(preview.token),
      })
      const applied = yield* body(applyResponse)
      const afterApply = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
      const reasoning = afterApply.data?.flatMap((message) => message.parts).find((part) => part.type === "reasoning")

      expect(applyResponse.status).toBe(200)
      expect(applied).toMatchObject({ parts: 1, turns: 1 })
      expect(reasoning).toMatchObject({ metadata: { "kilocode.reasoning": { cleared: expect.any(Number) } } })

      const stored = yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) => session.messages({ sessionID: SessionID.make(sessionID) })),
        ),
      )
      const projected = yield* Effect.promise(() => MessageV2.toModelMessages(stored, ProviderTest.model()))
      expect(JSON.stringify(projected)).not.toContain("old reasoning")
    }),
  )

  it.instance("clears provider carriers when includeCarriers is true", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "carrier clear" }))
      const sessionID = created.data!.id
      yield* seedReasoning(instance.directory, sessionID, {
        openai: { itemId: "rs_e2e", reasoningEncryptedContent: "encrypted-e2e" },
      })

      const skipped = yield* body(
        yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, { keepTurns: 1 }),
      )
      expect(skipped).toMatchObject({ parts: 0, carriers: 0, carrierCandidates: 1, unsupported: 0 })

      const previewResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, {
        keepTurns: 1,
        includeCarriers: true,
      })
      const preview = yield* body(previewResponse)
      expect(previewResponse.status).toBe(200)
      expect(preview).toMatchObject({
        parts: 1,
        carriers: 1,
        carrierCandidates: 1,
        unsupported: 0,
        tokens: expect.any(Number),
      })

      const applyResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear`, {
        keepTurns: 1,
        includeCarriers: true,
        token: String(preview.token),
      })
      expect(applyResponse.status).toBe(200)
      expect(yield* body(applyResponse)).toMatchObject({ parts: 1, turns: 1 })

      const stored = yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) => session.messages({ sessionID: SessionID.make(sessionID) })),
        ),
      )
      const projected = yield* Effect.promise(() => MessageV2.toModelMessages(stored, ProviderTest.model()))
      expect(JSON.stringify(projected)).not.toContain("encrypted-e2e")
      expect(JSON.stringify(projected)).not.toContain("old reasoning")
    }),
  )

  it.instance("clears signed Anthropic reasoning carriers and rejects a flag mismatch", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)
      const created = yield* Effect.promise(() => sdk.session.create({ title: "anthropic carrier clear" }))
      const sessionID = created.data!.id
      yield* seedReasoning(instance.directory, sessionID, { anthropic: { signature: "signed-e2e" } })

      const previewResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, {
        keepTurns: 1,
      })
      const preview = yield* body(previewResponse)
      expect(preview).toMatchObject({ parts: 0, carriers: 0, carrierCandidates: 1, unsupported: 0 })

      const mismatch = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear`, {
        keepTurns: 1,
        includeCarriers: true,
        token: String(preview.token),
      })
      expect(mismatch.status).toBe(409)

      const includedResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, {
        keepTurns: 1,
        includeCarriers: true,
      })
      const included = yield* body(includedResponse)
      expect(includedResponse.status).toBe(200)
      expect(included).toMatchObject({ parts: 1, carriers: 1, carrierCandidates: 1, unsupported: 0 })

      const applyResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear`, {
        keepTurns: 1,
        includeCarriers: true,
        token: String(included.token),
      })
      expect(applyResponse.status).toBe(200)
      expect(yield* body(applyResponse)).toMatchObject({ parts: 1, turns: 1 })

      const afterResponse = yield* post(instance.directory, `/session/${sessionID}/reasoning/clear/preview`, {
        keepTurns: 1,
      })
      expect(yield* body(afterResponse)).toMatchObject({
        parts: 0,
        carriers: 0,
        carrierCandidates: 0,
        unsupported: 0,
      })

      const stored = yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) => session.messages({ sessionID: SessionID.make(sessionID) })),
        ),
      )
      const projected = yield* Effect.promise(() => MessageV2.toModelMessages(stored, ProviderTest.model()))
      expect(JSON.stringify(projected)).not.toContain("signed-e2e")
      expect(JSON.stringify(projected)).not.toContain("old reasoning")
    }),
  )

  it.instance("returns guarded reasoning-clear HTTP errors and empty-session zeros", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sdk = yield* client(instance.directory)

      const missing = yield* post(instance.directory, "/session/ses_missing_reasoning/reasoning/clear/preview", {
        keepTurns: 1,
      })
      expect(missing.status).toBe(404)

      const busySession = yield* Effect.promise(() => sdk.session.create({ title: "busy reasoning" }))
      const busyID = busySession.data!.id
      yield* seedReasoning(instance.directory, busyID)
      const status = yield* SessionStatus.Service
      yield* status.set(SessionID.make(busyID), { type: "busy" })
      const busy = yield* post(instance.directory, `/session/${busyID}/reasoning/clear/preview`, { keepTurns: 1 })
      yield* status.set(SessionID.make(busyID), { type: "idle" })
      expect(busy.status).toBe(409)
      expect(yield* body(busy)).toMatchObject({ _tag: "SessionBusyError" })

      const staleSession = yield* Effect.promise(() => sdk.session.create({ title: "stale reasoning" }))
      const staleID = staleSession.data!.id
      const stalePartID = yield* seedReasoning(instance.directory, staleID)
      const stalePreviewResponse = yield* post(instance.directory, `/session/${staleID}/reasoning/clear/preview`, {
        keepTurns: 1,
      })
      const stalePreview = yield* body(stalePreviewResponse)
      yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) =>
            Effect.gen(function* () {
              const messages = yield* session.messages({ sessionID: SessionID.make(staleID) })
              const target = messages.flatMap((message) => message.parts).find((part) => part.id === stalePartID)
              if (!target) return yield* Effect.die(new Error("missing stale reasoning target"))
              const part = yield* session.getPart({
                sessionID: SessionID.make(staleID),
                messageID: target.messageID,
                partID: stalePartID,
              })
              if (!part || part.type !== "reasoning")
                return yield* Effect.die(new Error("missing stale reasoning part"))
              yield* session.updatePart({ ...part, text: "changed after preview" })
            }),
          ),
        ),
      )
      const stale = yield* post(instance.directory, `/session/${staleID}/reasoning/clear`, {
        keepTurns: 1,
        token: String(stalePreview.token),
      })
      expect(stale.status).toBe(409)
      expect(yield* body(stale)).toMatchObject({ _tag: "KiloReasoningClearStalePreviewError" })

      const unsupportedSession = yield* Effect.promise(() => sdk.session.create({ title: "unsupported reasoning" }))
      const unsupportedID = unsupportedSession.data!.id
      yield* seedReasoning(instance.directory, unsupportedID, { anthropic: { signature: "opaque" } })
      const unsupportedPreviewResponse = yield* post(
        instance.directory,
        `/session/${unsupportedID}/reasoning/clear/preview`,
        { keepTurns: 1 },
      )
      const unsupportedPreview = yield* body(unsupportedPreviewResponse)
      expect(unsupportedPreview).toMatchObject({ carrierCandidates: 1, unsupported: 0 })
      const unsupported = yield* post(instance.directory, `/session/${unsupportedID}/reasoning/clear`, {
        keepTurns: 1,
        token: String(unsupportedPreview.token),
      })
      expect(unsupported.status).toBe(200)
      expect(yield* body(unsupported)).toMatchObject({ parts: 0, turns: 0, tokens: 0 })

      const empty = yield* Effect.promise(() => sdk.session.create({ title: "empty reasoning" }))
      const emptyID = empty.data!.id
      const emptyPreviewResponse = yield* post(instance.directory, `/session/${emptyID}/reasoning/clear/preview`, {
        keepTurns: 10,
      })
      const emptyPreview = yield* body(emptyPreviewResponse)
      expect(emptyPreview).toMatchObject({ parts: 0, tokens: 0 })
      const emptyApply = yield* post(instance.directory, `/session/${emptyID}/reasoning/clear`, {
        keepTurns: 10,
        token: String(emptyPreview.token),
      })
      expect(emptyApply.status).toBe(200)
      expect(yield* body(emptyApply)).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
    }),
  )

  it.instance("rejects reasoning clear for reverted sessions", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const target = yield* ready(instance.directory, "reverted reasoning")

      yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) =>
            Effect.gen(function* () {
              const messages = yield* session.messages({ sessionID: SessionID.make(target.id) })
              const parent = messages.at(0)?.info.id
              if (!parent) return yield* Effect.die(new Error("missing reverted session message"))
              yield* session.setRevert({
                sessionID: SessionID.make(target.id),
                revert: { messageID: parent },
                summary: undefined,
              })
            }),
          ),
        ),
      )

      yield* rejects(instance.directory, target.id, target.token, "ConflictError")
    }),
  )

  it.instance("rejects reasoning clear for archived sessions", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const target = yield* ready(instance.directory, "archived reasoning")

      yield* InstanceStore.Service.use((store) =>
        store.provide(
          { directory: instance.directory },
          Session.Service.use((session) =>
            session.setArchived({ sessionID: SessionID.make(target.id), time: Date.now() }),
          ),
        ),
      )

      yield* rejects(instance.directory, target.id, target.token, "ConflictError")
    }),
  )

  it.instance("rejects reasoning clear while the session is busy", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const target = yield* ready(instance.directory, "busy reasoning apply")
      const status = yield* SessionStatus.Service

      yield* status.set(SessionID.make(target.id), { type: "busy" })
      yield* rejects(instance.directory, target.id, target.token, "SessionBusyError")
      yield* status.set(SessionID.make(target.id), { type: "idle" })
    }),
  )

  it.instance("rejects reasoning clear while a foreign process marker is live", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const target = yield* ready(instance.directory, "foreign reasoning")
      const directory = path.join(Global.Path.state, "session-turn")
      const marker = path.join(directory, `${target.id}.${process.ppid}`)
      yield* Effect.promise(async () => {
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(marker, os.hostname())
        const now = new Date()
        await fs.utimes(marker, now, now)
      })

      try {
        yield* rejects(instance.directory, target.id, target.token, "SessionBusyError")
      } finally {
        yield* Effect.promise(() => fs.rm(marker, { force: true }))
      }
    }),
  )
})
