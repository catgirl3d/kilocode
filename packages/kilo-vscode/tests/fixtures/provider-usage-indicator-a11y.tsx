import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
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
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLDivElement: window.HTMLDivElement,
  SVGElement: window.SVGElement,
  customElements: window.customElements,
  CSSStyleSheet: CSSStyleSheetStub,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})

globalThis.acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
})

const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { ServerContext } = await import("../../webview-ui/src/context/server")
const { ProviderUsageIndicator } = await import("../../webview-ui/src/components/chat/ProviderUsageIndicator")

const session = {
  ...mockSessionValue({ id: "ses_usage", status: "idle" }),
  selected: () => ({ providerID: "openai", modelID: "gpt-5.2" }),
}
const usage = {
  items: [
    {
      id: "codex-chatgpt",
      providerID: "openai",
      sourceKind: "direct",
      providerLabel: "OpenAI",
      planLabel: "ChatGPT Codex",
      sourceLabel: "ChatGPT OAuth",
      fetchState: "ready",
      planState: "active",
      routingState: "not_applicable",
      windows: [
        {
          id: "codex-primary",
          resource: "Codex",
          unit: "percent",
          orientation: "used_percent",
          state: "active",
          used: 42,
          remaining: 58,
          limit: 100,
          period: { unit: "hour", value: 5 },
          resetAt: "2026-06-19T05:00:00.000Z",
        },
      ],
    },
  ],
}
const server = {
  providerUsage: () => usage,
  providerUsageLoading: () => false,
  providerUsageError: () => undefined,
  requestProviderUsage: () => {},
  refreshProviderUsage: () => {},
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders noPadding>
      <ServerContext.Provider value={server as never}>
        <SessionContext.Provider value={session as never}>
          <ProviderUsageIndicator />
        </SessionContext.Provider>
      </ServerContext.Provider>
    </StoryProviders>
  ),
  root,
)

try {
  await window.happyDOM.waitUntilComplete()
  const ring = root.querySelector(".provider-usage-indicator")
  assert(ring, "quota ring should render")
  assert.equal(ring.getAttribute("tabindex"), "0")
  assert.equal(ring.getAttribute("role"), "status")
  assert.equal(ring.getAttribute("aria-label"), "Codex · 5-hour quota: 42% used, 58% remaining")
} finally {
  dispose()
  await window.happyDOM.close()
}
