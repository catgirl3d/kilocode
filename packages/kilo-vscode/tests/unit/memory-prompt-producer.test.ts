import { describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import fs from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const ROOT = path.resolve(import.meta.dir, "../..")
const WEBVIEW_MESSAGES_FILE = path.join(ROOT, "webview-ui/src/types/messages/webview-messages.ts")
const MEMORY_MESSAGES_FILE = path.join(ROOT, "webview-ui/src/types/messages/memory.ts")

function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

const fixture = `/** @jsxImportSource solid-js */
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
class CSSStyleSheetStub {
  replaceSync() {}
  replace() {
    return Promise.resolve(this)
  }
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  getComputedStyle: window.getComputedStyle.bind(window),
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLDivElement: window.HTMLDivElement,
  customElements: window.customElements,
  CSSStyleSheet: CSSStyleSheetStub,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})

const posts = []
globalThis.acquireVsCodeApi = () => ({
  postMessage: (message) => posts.push(message),
  getState: () => undefined,
  setState: () => {},
})

const { createComponent, onMount } = await import("solid-js")
const { render } = await import("solid-js/web")
const { LanguageContext } = await import("./webview-ui/src/context/language")
const { MemoryProvider, useMemory } = await import("./webview-ui/src/context/memory")
const { ServerContext } = await import("./webview-ui/src/context/server")
const { SessionContext } = await import("./webview-ui/src/context/session")
const { VSCodeProvider } = await import("./webview-ui/src/context/vscode")
const { mockSessionValue } = await import("./webview-ui/src/stories/StoryProviders")

const session = mockSessionValue({ id: "ses_memory", status: "idle" })
const server = {
  isConnected: () => true,
  workspaceDirectory: () => "/repo",
}
const language = {
  locale: () => "en",
  setLocale: () => {},
  userOverride: () => undefined,
  t: (key) => key,
}
const Probe = () => {
  const memory = useMemory()
  onMount(() => {
    memory.remember()
    memory.forget()
  })
  return null
}
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(ServerContext.Provider, {
          value: server,
          get children() {
            return createComponent(LanguageContext.Provider, {
              value: language,
              get children() {
                return createComponent(SessionContext.Provider, {
                  value: session,
                  get children() {
                    return createComponent(MemoryProvider, {
                      get children() {
                        return createComponent(Probe, {})
                      },
                    })
                  },
                })
              },
            })
          },
        })
      },
    }),
  root,
)
await window.happyDOM.waitUntilComplete()
dispose()
root.remove()
console.log("RESULT:" + JSON.stringify(posts.filter((post) => post.type === "memoryPrompt")))
`

describe("memory prompt producer", () => {
  it("posts remember and forget messages through the real MemoryProvider", async () => {
    const webview = path.join(ROOT, "webview-ui")
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
      stdin: { contents: fixture, loader: "tsx", resolveDir: ROOT, sourcefile: "memory-prompt-producer.tsx" },
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
    const file = path.join(ROOT, `.memory-prompt-producer-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    try {
      const child = Bun.spawnSync([process.execPath, file], { cwd: webview, stdout: "pipe", stderr: "pipe" })
      const output = child.stdout.toString() + child.stderr.toString()
      expect(child.exitCode, output).toBe(0)
      const line = output.split(/\r?\n/).find((item) => item.startsWith("RESULT:"))
      expect(line).toBeDefined()
      expect(JSON.parse(line!.slice("RESULT:".length))).toEqual([
        { type: "memoryPrompt", operation: "remember", sessionID: "ses_memory" },
        { type: "memoryPrompt", operation: "forget", sessionID: "ses_memory" },
      ])
    } finally {
      unlinkSync(file)
    }
  }, 30_000)
})

describe("memory prompt message contract", () => {
  it("keeps the prompt message in WebviewMessage with its discriminant", () => {
    const union = stripComments(fs.readFileSync(WEBVIEW_MESSAGES_FILE, "utf-8"))
    const memory = stripComments(fs.readFileSync(MEMORY_MESSAGES_FILE, "utf-8"))
    expect(union).toContain("| MemoryPromptMessage")
    expect(memory).toMatch(
      /interface MemoryPromptMessage[\s\S]*type: "memoryPrompt"[\s\S]*operation: "remember" \| "forget"/,
    )
  })
})
