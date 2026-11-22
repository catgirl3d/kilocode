import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { VSCodeAPI, WebviewMessage } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const sent: WebviewMessage[] = []
const api: VSCodeAPI = {
  postMessage: (message) => sent.push(message),
  getState: () => undefined,
  setState: () => {},
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  customElements: window.customElements,
  Event: window.Event,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { ProviderProvider } = await import("../../webview-ui/src/context/provider")
const { post } = await import("../../webview-ui/src/utils/webview-message")

const host = document.createElement("div")
document.body.append(host)
const realSetTimeout = globalThis.setTimeout
const timers: Array<() => void> = []
globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (delay === 3000) {
    timers.push(callback as () => void)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }
  return realSetTimeout(callback, delay, ...args)
}) as typeof setTimeout

const requests = () => sent.filter((message) => message.type === "requestProviders").length
const tick = async () => {
  await Promise.resolve()
}
const mount = () =>
  render(
    () => (
      <VSCodeProvider>
        <ProviderProvider />
      </VSCodeProvider>
    ),
    host,
  )

let dispose: (() => void) | undefined
try {
  dispose = mount()
  await tick()
  assert.equal(requests(), 1, "mount requests providers once")
  assert.equal(timers.length, 1, "mount schedules the provider fallback")

  post({
    type: "providersLoaded",
    providers: {},
    connected: [],
    defaults: {},
    ready: true,
    defaultSelection: { providerID: "kilo", modelID: "kilo-auto/free" },
  })
  for (const timer of timers) timer()
  assert.equal(requests(), 1, "an empty loaded catalog does not retry")
  post({ type: "extensionDataReady" })
  assert.equal(requests(), 1, "extensionDataReady does not retry a loaded catalog")

  dispose()
  dispose = undefined
  sent.length = 0
  timers.length = 0

  dispose = mount()
  await tick()
  assert.equal(requests(), 1, "a fresh mount requests providers once")
  assert.equal(timers.length, 1, "a fresh mount schedules the provider fallback")
  for (const timer of timers) timer()
  assert.equal(requests(), 2, "the fallback retries before providers load")
  post({ type: "extensionDataReady" })
  assert.equal(requests(), 3, "extensionDataReady retries before providers load")
  console.log("provider retry fixture: PASS")
} finally {
  try {
    dispose?.()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}
