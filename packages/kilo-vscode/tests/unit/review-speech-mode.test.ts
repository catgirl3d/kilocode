import { describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const ROOT = path.resolve(import.meta.dir, "../..")
const WEBVIEW = path.join(ROOT, "webview-ui")
const SPEECH = path.join(WEBVIEW, "diff-viewer/review-annotation-speech.tsx")
const CONTROLLER = path.join(WEBVIEW, "diff-viewer/review-controller.ts")
const PANEL = path.join(WEBVIEW, "agent-manager/DiffPanel.tsx")
const FULLSCREEN = path.join(WEBVIEW, "diff-viewer/FullScreenDiffView.tsx")

function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}
const SCRIPT = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.HTMLElement = window.HTMLElement
  globalThis.MutationObserver = window.MutationObserver

  const { createSignal } = await import("solid-js")
  const { createReviewAnnotationSpeechRenderer } = await import("./diff-viewer/review-annotation-speech.tsx")

  const calls: Array<{ model: string; mode?: string }> = []
  const speech = {
    state: () => "idle",
    error: () => undefined,
    active: () => false,
    start: (opts: { model: string; mode?: string }) => calls.push(opts),
    stop: () => {},
    cancel: () => {},
    clear: () => {},
  }
  const [mode, setMode] = createSignal("translate")
  const renderer = createReviewAnnotationSpeechRenderer({
    speech,
    enabled: () => true,
    model: () => "test/model",
    mode,
    label: (key) => key,
    keys: () => new Set(["draft:file.ts:additions:1:1"]),
  })
  const textarea = document.createElement("textarea")
  const meta = { type: "draft", comment: null, file: "file.ts", side: "additions", line: 1 }

  const host = renderer.render(meta, textarea)
  if (!host) throw new Error("speech button host did not render")
  document.body.append(host)
  const button = host.querySelector("button")
  if (!button) throw new Error("speech button did not render")
  button.click()
  setMode("transcribe")
  button.click()
  if (calls.map((call) => call.mode).join(",") !== "translate,transcribe") {
    throw new Error("click path: " + JSON.stringify(calls))
  }

  calls.length = 0
  setMode("translate")
  renderer.down(meta, { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, timeStamp: 1 }, () => {})
  renderer.up(meta, { key: "k", timeStamp: 1 })
  if (calls.map((call) => call.mode).join(",") !== "translate") {
    throw new Error("shortcut path: " + JSON.stringify(calls))
  }
`

describe("review speech mode wiring", () => {
  it("review speech renderer starts speech with the selected mode", () => {
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", WEBVIEW))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
    }
    return build({
      stdin: { contents: SCRIPT, resolveDir: WEBVIEW, sourcefile: "review-speech-mode.ts", loader: "ts" },
      bundle: true,
      conditions: ["browser"],
      external: ["happy-dom"],
      format: "esm",
      platform: "node",
      logLevel: "silent",
      plugins: [
        {
          name: "solid-dedupe",
          setup(ctx) {
            ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
          },
        },
        solidPlugin(),
      ],
      target: "es2022",
      write: false,
    }).then((result) => {
      const file = path.join(ROOT, `.review-speech-mode-${crypto.randomUUID()}.mjs`)
      return Bun.write(file, result.outputFiles[0]!.contents).then(() => {
        try {
          const child = Bun.spawnSync([process.execPath, file], { cwd: WEBVIEW, stdout: "pipe", stderr: "pipe" })
          const output = child.stdout.toString() + child.stderr.toString()
          if (child.exitCode !== 0) throw new Error(output)
        } finally {
          unlinkSync(file)
        }
      })
    })
  }, 30_000)

  it("DiffPanel passes speechMode to the review controller", () => {
    expect(stripComments(readFileSync(PANEL, "utf8"))).toMatch(/mode:\s*speechMode/)
  })

  it("FullScreenDiffView passes speechMode to the review controller", () => {
    expect(stripComments(readFileSync(FULLSCREEN, "utf8"))).toMatch(/mode:\s*speechMode/)
  })

  it("review controller forwards mode to the speech renderer", () => {
    expect(stripComments(readFileSync(CONTROLLER, "utf8"))).toMatch(/mode:\s*props\.mode/)
  })

  it("review speech renderer starts speech with its mode accessor", () => {
    expect(stripComments(readFileSync(SPEECH, "utf8"))).toMatch(/start\(props\.model\(\), props\.mode\(\)\)/)
  })
})
