import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { WorktreeFileDiff } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })

/**
 * Virtua measures the viewport through ResizeObserver and skips entries whose
 * target has no offsetParent. Happy DOM produces neither, so report a fixed
 * content rect and give every observed element an offsetParent.
 */
class FakeResizeObserver {
  constructor(private readonly notify: ResizeObserverCallback) {}
  observe(target: Element) {
    Object.defineProperty(target, "offsetParent", { value: window.document.body, configurable: true })
    queueMicrotask(() =>
      this.notify(
        [{ target, contentRect: { width: 600, height: 800 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      ),
    )
  }
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", { value: FakeResizeObserver, configurable: true, writable: true })
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  SVGElement: window.SVGElement,
  customElements: window.customElements,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  CustomEvent: window.CustomEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: FakeResizeObserver,
})

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { DiffPanel } = await import("../../webview-ui/agent-manager/DiffPanel")
const { FullScreenDiffView } = await import("../../webview-ui/diff-viewer/FullScreenDiffView")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { ConfigContext } = await import("../../webview-ui/src/context/config")
const { ServerContext } = await import("../../webview-ui/src/context/server")
const { ProviderContext } = await import("../../webview-ui/src/context/provider")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")

const language = { locale: () => "en", setLocale: () => undefined, userOverride: () => "", t: (key: string) => key }
const config = { config: () => ({ experimental: {} }), features: () => ({ speechToText: false }) }
const server = { goToLogin: () => undefined }
const provider = { authStates: () => ({}) }

const staged: WorktreeFileDiff[] = [
  {
    file: "src/alpha.ts",
    before: "",
    after: "",
    additions: 12,
    deletions: 3,
    status: "modified",
    tracked: true,
    summarized: true,
    stamp: "modified:12:3",
  },
  {
    file: "src/beta.ts",
    before: "",
    after: "",
    additions: 40,
    deletions: 0,
    status: "added",
    tracked: true,
    summarized: true,
    stamp: "added:40:0",
  },
]

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
const names = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-slot="session-review-filename"]')].map((node) => node.textContent ?? "").sort()

// The diff side panel: mounted before the async git fetch lands, then updated.
const [diffs, setDiffs] = createSignal<WorktreeFileDiff[]>([])
const panelRoot = document.createElement("div")
document.body.append(panelRoot)
render(
  () => (
    <LanguageContext.Provider value={language as never}>
      <ConfigContext.Provider value={config as never}>
        <ServerContext.Provider value={server as never}>
          <ProviderContext.Provider value={provider as never}>
            <VSCodeProvider>
              <DiffPanel
                diffs={diffs()}
                loading={false}
                comments={[]}
                onCommentsChange={() => undefined}
                sessionKey="fixture#staged"
                canRevert={false}
                diffStyle="unified"
                onDiffStyleChange={() => undefined}
                markdownRender={false}
                onMarkdownRenderChange={() => undefined}
                onClose={() => undefined}
              />
            </VSCodeProvider>
          </ProviderContext.Provider>
        </ServerContext.Provider>
      </ConfigContext.Provider>
    </LanguageContext.Provider>
  ),
  panelRoot,
)
await settle()
assert.deepEqual(names(panelRoot), [], "no rows before the diff arrives")
setDiffs(staged)
await settle()
assert.deepEqual(names(panelRoot), ["alpha.ts", "beta.ts"], "DiffPanel renders rows that arrive after mount")

// The full-screen review: same surface, same live-props requirement.
const [reviewDiffs, setReviewDiffs] = createSignal<WorktreeFileDiff[]>([])
const reviewRoot = document.createElement("div")
document.body.append(reviewRoot)
render(
  () => (
    <LanguageContext.Provider value={language as never}>
      <ConfigContext.Provider value={config as never}>
        <ServerContext.Provider value={server as never}>
          <ProviderContext.Provider value={provider as never}>
            <VSCodeProvider>
              <FullScreenDiffView
                diffs={reviewDiffs()}
                loading={false}
                comments={[]}
                onCommentsChange={() => undefined}
                sessionKey="fixture#staged"
                canRevert={false}
                diffStyle="unified"
                onDiffStyleChange={() => undefined}
                markdownRender={false}
                onMarkdownRenderChange={() => undefined}
                onClose={() => undefined}
              />
            </VSCodeProvider>
          </ProviderContext.Provider>
        </ServerContext.Provider>
      </ConfigContext.Provider>
    </LanguageContext.Provider>
  ),
  reviewRoot,
)
await settle()
assert.deepEqual(names(reviewRoot), [], "no review rows before the diff arrives")
setReviewDiffs(staged)
await settle()
assert.deepEqual(names(reviewRoot), ["alpha.ts", "beta.ts"], "FullScreenDiffView renders rows that arrive after mount")

await window.happyDOM.close()
