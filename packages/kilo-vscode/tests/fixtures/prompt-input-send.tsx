import assert from "node:assert/strict"
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
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  SVGElement: window.SVGElement,
  ShadowRoot: window.ShadowRoot,
  customElements: window.customElements,
  CSSStyleSheet: CSSStyleSheetStub,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  InputEvent: window.InputEvent,
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
const { PromptInput } = await import("../../webview-ui/src/components/chat/PromptInput")

async function settle() {
  await window.happyDOM.waitUntilComplete()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

async function run(resumable: boolean) {
  const calls: string[] = []
  const base = mockSessionValue({ id: "session", status: "idle" })
  const session = {
    ...base,
    canResume: () => resumable,
    resume: () => calls.push("resume"),
    sendMessage: (text: string) => calls.push(`send:${text}`),
  }
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding>
        <SessionContext.Provider value={session as never}>
          <PromptInput />
        </SessionContext.Provider>
      </StoryProviders>
    ),
    root,
  )

  try {
    await settle()
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ready", serverInfo: { version: "test" }, workspaceDirectory: "/repo" },
      }),
    )
    await settle()
    const button = root.querySelector<HTMLButtonElement>(".prompt-input-hint-actions button[aria-disabled]")
    assert.ok(button, "send button did not render")
    assert.equal(button.getAttribute("aria-disabled"), "false")
    button.click()
    await settle()
    return calls
  } finally {
    dispose()
    root.remove()
  }
}

assert.deepEqual(await run(true), ["resume"])
assert.deepEqual(await run(false), ["send:continue"])
