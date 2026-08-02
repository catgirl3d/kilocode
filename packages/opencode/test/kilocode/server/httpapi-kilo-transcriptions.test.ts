import { describe, expect, spyOn, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HEADER_FEATURE, HEADER_ORGANIZATIONID } from "@kilocode/kilo-gateway"
import { GROQ_TRANSCRIPTIONS_URL, GROQ_TRANSLATIONS_URL } from "@kilocode/kilo-gateway/speech-to-text"
import * as Log from "@opencode-ai/core/util/log"
import { KiloGatewayPaths } from "../../../src/kilocode/server/httpapi/groups/kilo-gateway"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const env = {
  KILO_AUTH_CONTENT: process.env.KILO_AUTH_CONTENT,
}

const payload = {
  model: "groq/whisper-large-v3-turbo",
  input_audio: { data: Buffer.alloc(44).toString("base64"), format: "wav" },
  language: "en",
}
const opts = { timeout: 30_000 }

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler

  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        HttpApiServer.context,
      )
    },
  }
}

async function send(body: Record<string, unknown> = payload) {
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  return app().request(KiloGatewayPaths.audioTranscriptions, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
    body: JSON.stringify(body),
  })
}

function stub(run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetch: typeof globalThis.fetch = Object.assign(run, { preconnect: globalThis.fetch.preconnect })
  return spyOn(globalThis, "fetch").mockImplementation(fetch)
}

function url(input: RequestInfo | URL) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function restore() {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function clean() {
  restore()
  await disposeAllInstances()
  await resetDatabase()
}

async function run(fn: () => Promise<void>) {
  try {
    await fn()
  } finally {
    await clean()
  }
}

describe("HttpApi Kilo audio transcriptions", () => {
  test(
    "proxies Groq Whisper transcription without forcing the webview locale",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ groq: { type: "api", key: "groq-token" } })
        const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
        const mock = stub(async (input, init) => {
          if (url(input) !== GROQ_TRANSCRIPTIONS_URL) return Response.json([])
          calls.push({ input, init })
          return Response.json({ text: "Recorded prompt" })
        })

        try {
          const response = await send()
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ text: "Recorded prompt" })
          expect(calls).toHaveLength(1)
          const call = calls[0]
          if (!call) throw new Error("missing Groq request")
          expect(url(call.input)).toBe(GROQ_TRANSCRIPTIONS_URL)
          const headers = new Headers(call.init?.headers)
          expect(headers.get("authorization")).toBe("Bearer groq-token")
          expect(headers.get(HEADER_ORGANIZATIONID)).toBeNull()
          expect(headers.get(HEADER_FEATURE)).toBeNull()
          expect(call.init?.body).toBeInstanceOf(FormData)
          const form = call.init?.body as FormData
          expect(form.get("model")).toBe("whisper-large-v3-turbo")
          expect(form.get("language")).toBeNull()
          expect(form.get("prompt")).toBeNull()
          expect(form.get("response_format")).toBe("json")
          const file = form.get("file")
          expect(file).toBeInstanceOf(Blob)
          expect((file as Blob).size).toBe(44)
        } finally {
          mock.mockRestore()
        }
      }),
    opts,
  )

  test(
    "uses Groq's English translation endpoint only for Whisper Large V3",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ groq: { type: "api", key: "groq-token" } })
        const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
        const mock = stub(async (input, init) => {
          if (url(input) !== GROQ_TRANSLATIONS_URL) return Response.json([])
          calls.push({ input, init })
          return Response.json({ text: "Translated prompt" })
        })

        try {
          const response = await send({ ...payload, model: "groq/whisper-large-v3", mode: "translate" })
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ text: "Translated prompt" })
          const call = calls[0]
          if (!call) throw new Error("missing Groq translation request")
          expect(url(call.input)).toBe(GROQ_TRANSLATIONS_URL)
          const form = call.init?.body as FormData
          expect(form.get("model")).toBe("whisper-large-v3")
        } finally {
          mock.mockRestore()
        }
      }),
    opts,
  )

  test(
    "sends M4A recordings to Groq's translation endpoint with the correct file metadata",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ groq: { type: "api", key: "groq-token" } })
        const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
        const mock = stub(async (input, init) => {
          if (url(input) !== GROQ_TRANSLATIONS_URL) return Response.json([])
          calls.push({ input, init })
          return Response.json({ text: "Translated prompt" })
        })

        try {
          const response = await send({
            ...payload,
            model: "groq/whisper-large-v3",
            mode: "translate",
            input_audio: { data: Buffer.alloc(44).toString("base64"), format: "m4a" },
          })
          expect(response.status).toBe(200)
          const call = calls[0]
          if (!call) throw new Error("missing Groq translation request")
          const form = call.init?.body as FormData
          const file = form.get("file") as File
          expect(file.name).toBe("recording.m4a")
          expect(file.type).toBe("audio/mp4")
        } finally {
          mock.mockRestore()
        }
      }),
    opts,
  )

  test(
    "rejects Groq Whisper Large V3 Turbo translation",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({ groq: { type: "api", key: "groq-token" } })

        const response = await send({ ...payload, mode: "translate" })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: "Groq model whisper-large-v3-turbo does not support voice translation",
        })
      }),
    opts,
  )

  test(
    "rejects translation for Kilo Gateway models without proxying it",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = "{}"

        const response = await send({ ...payload, model: "openai/whisper-large-v3", mode: "translate" })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: "Voice translation is only supported by compatible Groq models",
        })
      }),
    opts,
  )

  test(
    "returns a direct credential error without requiring Kilo authentication",
    () =>
      run(async () => {
        process.env.KILO_AUTH_CONTENT = "{}"

        const response = await send()
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: "Groq API key is not configured" })
      }),
    opts,
  )
})
