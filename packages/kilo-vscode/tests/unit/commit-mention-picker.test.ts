import { expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

it("renders commit metadata and handles selection, Escape, and search through the real List", async () => {
  const pkg = path.resolve(import.meta.dir, "../..")
  const root = path.resolve(pkg, "../..")
  const webview = path.join(pkg, "webview-ui")
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
  const result = await build({
    stdin: {
      contents: `
import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
})

const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { CommitMentionPicker } = await import("./packages/kilo-vscode/webview-ui/src/components/chat/CommitMentionPicker")
const commit = {
  hash: "0123456789abcdef0123456789abcdef01234567",
  shortHash: "0123456",
  subject: "Fix auth flow",
  author: "A. Developer",
  date: "2 days ago",
}
const state: { selected: unknown; query: string; closed: number } = { selected: undefined, query: "", closed: 0 }
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(CommitMentionPicker, {
      commits: [commit],
      onSearch: (query) => (state.query = query),
      onSelect: (picked) => (state.selected = picked),
      onClose: () => state.closed++,
    }),
  root,
)

try {
  await window.happyDOM.waitUntilComplete()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()

  const row = root.querySelector<HTMLButtonElement>("[data-slot='list-item']")
  assert.ok(row, "commit row did not render")
  const text = row.textContent ?? ""
  for (const value of [commit.subject, commit.shortHash, commit.author, commit.date]) {
    assert.ok(text.includes(value), "commit row is missing " + value)
  }

  row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  assert.equal(state.selected, commit, "Enter should select the full commit object")

  const input = root.querySelector<HTMLInputElement>("input")
  assert.ok(input, "commit search field did not render")
  input.value = "auth flow"
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "auth flow" }))
  assert.equal(state.query, "auth flow", "typing should forward the query to onSearch")

  row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  assert.equal(state.closed, 1, "Escape should close the picker")
} finally {
  dispose()
  root.remove()
  await window.happyDOM.close()
}
`,
      resolveDir: root,
      sourcefile: "commit-mention-picker.fixture.ts",
      loader: "ts",
    },
    bundle: true,
    conditions: ["browser"],
    external: ["happy-dom"],
    format: "esm",
    loader: { ".css": "empty", ".svg": "dataurl" },
    logLevel: "silent",
    platform: "node",
    plugins: [dedupe, solidPlugin()],
    target: "es2022",
    write: false,
  })
  const file = path.join(pkg, `.commit-mention-picker-${crypto.randomUUID()}.mjs`)
  await Bun.write(file, result.outputFiles[0]!.contents)
  try {
    const child = Bun.spawnSync([process.execPath, file], { cwd: webview, stdout: "pipe", stderr: "pipe" })
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
  } finally {
    unlinkSync(file)
  }
}, 30_000)
