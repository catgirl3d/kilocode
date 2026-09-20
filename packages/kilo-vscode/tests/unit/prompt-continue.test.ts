import { describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { continuation } from "../../webview-ui/src/context/session-continuation"
import type { Message, Part } from "../../webview-ui/src/types/messages"

const user: Message = { id: "user", sessionID: "session", role: "user", createdAt: "2026-01-01" }
const assistant: Message = {
  id: "assistant",
  sessionID: "session",
  role: "assistant",
  parentID: user.id,
  createdAt: "2026-01-01",
  error: { name: "MessageAbortedError" },
}
const input = {
  id: "session",
  status: "idle",
  messages: [user, assistant],
  parts: (_: string): Part[] => [],
  submitting: false,
  blocked: false,
  loading: false,
  reverted: false,
}

describe("empty prompt continuation", () => {
  it("targets the stopped assistant rather than creating a new user turn", () => {
    expect(continuation(input)).toBe(assistant.id)
    expect(continuation({ ...input, messages: [user, { ...assistant, finish: "stop" }] })).toBe(assistant.id)
  })

  it("keeps a stopped turn resumable while background results wait for user input", () => {
    const job = { ...user, id: "background" }
    const part: Part = {
      id: "result",
      sessionID: "session",
      messageID: job.id,
      type: "text",
      text: "Background task completed",
      synthetic: true,
      metadata: { background: true },
    }
    const next = {
      ...input,
      messages: [user, assistant, job],
      parts: (id: string) => (id === job.id ? [part] : []),
    }
    expect(continuation(next)).toBe(assistant.id)
    expect(continuation({ ...next, parts: () => [{ ...part, metadata: {} }] })).toBeUndefined()
    expect(
      continuation({
        ...next,
        messages: [...next.messages, { ...assistant, id: "reply", parentID: job.id, error: undefined, finish: "stop" }],
      }),
    ).toBeUndefined()
  })

  it("accepts unfinished assistant and tool-call turns", () => {
    for (const finish of [undefined, "tool-calls"]) {
      expect(continuation({ ...input, messages: [user, { ...assistant, error: undefined, finish }] })).toBe(
        assistant.id,
      )
    }
  })

  it("does not resume completed, filtered, limited, or failed responses", () => {
    for (const finish of ["stop", "length", "unknown", "content-filter", "error"]) {
      expect(continuation({ ...input, messages: [user, { ...assistant, error: undefined, finish }] })).toBeUndefined()
    }
    expect(continuation({ ...input, messages: [user, { ...assistant, error: { name: "APIError" } }] })).toBeUndefined()
  })

  it("does not resume empty chats, previews, or a different user turn", () => {
    expect(continuation({ ...input, id: undefined })).toBeUndefined()
    expect(continuation({ ...input, id: "cloud:preview" })).toBeUndefined()
    expect(continuation({ ...input, messages: [] })).toBeUndefined()
    expect(continuation({ ...input, messages: [user] })).toBeUndefined()
    expect(continuation({ ...input, messages: [user, { ...assistant, parentID: "older-user" }] })).toBeUndefined()
    expect(continuation({ ...input, messages: [user, assistant, { ...user, id: "next-user" }] })).toBeUndefined()
    expect(continuation({ ...input, messages: [user, { ...assistant, summary: true }] })).toBeUndefined()
  })

  it("keeps busy, pending, blocked, loading, and reverted sessions unavailable", () => {
    for (const status of ["busy", "retry", "offline"]) {
      expect(continuation({ ...input, status })).toBeUndefined()
    }
    for (const key of ["submitting", "blocked", "loading", "reverted"] as const) {
      expect(continuation({ ...input, [key]: true })).toBeUndefined()
    }
  })
})

describe("PromptInput empty send", () => {
  it("sends attachment-only review comments, images, and browser references instead of continue", async () => {
    const root = path.resolve(import.meta.dir, "../..")
    const webview = path.join(root, "webview-ui")
    const fixture = path.join(root, "tests/fixtures/prompt-input-send.tsx")
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", webview))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
    }
    const dedupe = {
      name: "solid-dedupe",
      setup(ctx: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
      },
    }
    const workers = {
      name: "worker-url",
      setup(ctx: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        ctx.onResolve({ filter: /\?worker&url$/ }, (args) => ({ path: args.path, namespace: "worker-url" }))
        ctx.onLoad({ filter: /.*/, namespace: "worker-url" }, () => ({
          contents: "export default 'test-worker.js'",
          loader: "js",
        }))
      },
    }
    const result = await build({
      entryPoints: [fixture],
      bundle: true,
      conditions: ["browser"],
      external: ["happy-dom"],
      format: "esm",
      logLevel: "silent",
      loader: { ".css": "empty", ".svg": "empty" },
      platform: "node",
      plugins: [dedupe, workers, solidPlugin()],
      target: "es2022",
      write: false,
    })
    const file = path.join(root, `.prompt-input-send-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    try {
      const child = Bun.spawnSync([process.execPath, file], { cwd: webview, stdout: "pipe", stderr: "pipe" })
      const output = child.stdout.toString() + child.stderr.toString()
      expect(child.exitCode, output).toBe(0)
    } finally {
      unlinkSync(file)
    }
  }, 30_000)
})
