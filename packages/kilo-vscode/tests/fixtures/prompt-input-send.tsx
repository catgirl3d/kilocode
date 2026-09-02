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
const { ServerContext } = await import("../../webview-ui/src/context/server")
const { PromptInput } = await import("../../webview-ui/src/components/chat/PromptInput")
const { browserDrafts: references, imageDrafts, reviewDrafts } = await import("../../webview-ui/src/utils/draft-store")

async function settle() {
  await window.happyDOM.waitUntilComplete()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

type AttachmentCase = "review" | "image" | "browser"

async function run(resumable: boolean, attachment?: AttachmentCase) {
  const calls: Array<string | { message: string; files?: unknown[]; review?: unknown; browser?: unknown }> = []
  const base = mockSessionValue({ id: "session", status: "idle" })
  const session = {
    ...base,
    canResume: () => resumable,
    resume: () => calls.push("resume"),
    sendMessage: (...args: unknown[]) =>
      calls.push({ message: args[0] as string, files: args[3] as unknown[], review: args[6], browser: args[8] }),
  }
  const key = "prompt:default:session:session"
  if (attachment === "review") {
    reviewDrafts.set(key, [
      {
        id: "comment-1",
        file: "src/app.ts",
        side: "additions",
        line: 7,
        comment: "actual review comment",
        selectedText: "",
      },
    ])
  }
  if (attachment === "image") {
    imageDrafts.set(key, [
      { id: "image-1", dataUrl: "data:image/png;base64,abc", mime: "image/png", filename: "screen.png" },
    ])
  }
  if (attachment === "browser") {
    references.set(key, [
      {
        id: "browser-1",
        sessionId: "session",
        selector: "#app",
        title: "Example page",
        url: "https://example.com/page",
      },
    ])
  }
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding>
        <ServerContext.Provider
          value={
            {
              connectionState: () => "connected",
              isConnected: () => true,
              gitInstalled: () => false,
              workspaceDirectory: () => "/repo",
            } as never
          }
        >
          <SessionContext.Provider value={session as never}>
            <PromptInput />
          </SessionContext.Provider>
        </ServerContext.Provider>
      </StoryProviders>
    ),
    root,
  )

  try {
    await settle()
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
const continued = await run(false)
assert.equal(continued.length, 1)
assert.equal((continued[0] as { message: string }).message, "continue")

const review = await run(true, "review")
assert.equal(review.length, 1)
assert.equal(
  (review[0] as { message: string }).message,
  "## Review Comments\n\n**src/app.ts** (line 7):\nactual review comment",
)
assert.notEqual((review[0] as { message: string }).message, "continue")
assert.deepEqual((review[0] as { review: unknown }).review, {
  version: 1,
  comments: [
    {
      id: "comment-1",
      file: "src/app.ts",
      side: "additions",
      line: 7,
      comment: "actual review comment",
      selectedText: "",
    },
  ],
})

const image = await run(true, "image")
assert.equal(image.length, 1)
assert.equal((image[0] as { message: string }).message, "")
assert.notEqual((image[0] as { message: string }).message, "continue")
assert.deepEqual((image[0] as { files: unknown[] }).files, [
  { mime: "image/png", url: "data:image/png;base64,abc", filename: "screen.png" },
])

const browser = await run(true, "browser")
assert.equal(browser.length, 1)
assert.equal(
  (browser[0] as { message: string }).message,
  "## Browser Feedback\n\nPage: Example page (`https://example.com/page`)\n\nElement 1:\n```\n#app\n```",
)
assert.deepEqual((browser[0] as { browser: unknown }).browser, {
  version: 1,
  references: [
    {
      id: "browser-1",
      sessionId: "session",
      selector: "#app",
      title: "Example page",
      url: "https://example.com/page",
    },
  ],
})
