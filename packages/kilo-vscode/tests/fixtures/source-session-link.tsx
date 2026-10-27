import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

const win = new Window({ url: "http://localhost" })
Object.defineProperty(win, "origin", { value: win.location.origin })
Object.assign(globalThis, {
  window: win,
  document: win.document,
  customElements: win.customElements,
  navigator: win.navigator,
  Node: win.Node,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLDivElement: win.HTMLDivElement,
  HTMLPreElement: win.HTMLPreElement,
  SVGElement: win.SVGElement,
  MessageEvent: win.MessageEvent,
  MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver,
  CustomEvent: win.CustomEvent,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win),
})

const messages: WebviewMessage[] = []
Object.defineProperty(globalThis, "acquireVsCodeApi", {
  value: () => ({
    postMessage: (message: WebviewMessage) => messages.push(message),
    getState: () => undefined,
    setState: () => {},
  }),
})

// Load browser modules only after the DOM globals exist.
const { render } = await import("solid-js/web")
const { DataProvider } = await import("@opencode-ai/ui/context/data")
const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { MarkedProvider, createMarkedParser } = await import("@kilocode/kilo-ui/context/marked")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { VscodeUserMessage } = await import("../../webview-ui/src/components/chat/VscodeUserMessage")

const parser = createMarkedParser({})
const language = { locale: () => "en", setLocale: () => {}, userOverride: () => "", t: (key: string) => key }
const message = {
  id: "msg_peer",
  sessionID: "ses_target",
  role: "user",
  time: { created: 1 },
  agent: "code",
  model: { providerID: "test", modelID: "test" },
}
// A peer request from a sidebar session: Agent Manager has no tab for ses_sidebar.
const parts = [
  {
    id: "prt_peer",
    sessionID: "ses_target",
    messageID: "msg_peer",
    type: "text",
    text: "[Agent Manager peer request]\nCheck the build.\n\n<!-- kilo-agent-manager source=ses_sidebar -->",
  },
]

const disposals: Array<() => void> = []
// `onSource` is how Agent Manager focuses a tab it already shows; the sidebar passes nothing.
async function mount(onSource?: (id: string) => boolean) {
  const root = document.createElement("div")
  document.body.append(root)
  disposals.push(
    render(
      () => (
        <VSCodeProvider>
          <LanguageContext.Provider value={language as never}>
            <DataProvider
              data={{ session: [], session_status: {}, session_diff: {}, message: {}, part: {} }}
              directory="/project"
            >
              <DialogProvider>
                <MarkedProvider nativeParser={async (text) => parser.parse(text)}>
                  <VscodeUserMessage message={message as never} parts={parts as never} {...({ onSource } as {})} />
                </MarkedProvider>
              </DialogProvider>
            </DataProvider>
          </LanguageContext.Provider>
        </VSCodeProvider>
      ),
      root,
    ),
  )
  await Promise.resolve()
  await win.happyDOM.waitUntilComplete()
  return root
}
const link = (root: HTMLElement) => {
  const button = root.querySelector<HTMLButtonElement>('[aria-label="Go to originating session"]')
  assert(button, "the source link renders for a sender without an Agent Manager tab")
  return button
}
const opened = () => messages.filter((item) => (item.type as string) === "openSourceSession")

try {
  const sidebar = await mount()
  assert.match(sidebar.textContent ?? "", /Sent by Kilo from another session/)
  assert.doesNotMatch(sidebar.textContent ?? "", /Session not open/)
  link(sidebar).click()
  assert.deepEqual(opened(), [{ type: "openSourceSession", sessionID: "ses_sidebar" }])

  const focused: string[] = []
  const tab = await mount((id) => {
    focused.push(id)
    return true
  })
  link(tab).click()
  assert.deepEqual(focused, ["ses_sidebar"], "Agent Manager gets the first chance to focus its own tab")
  assert.equal(opened().length, 1, "a tab Agent Manager focused needs no extension round trip")

  const missing: string[] = []
  const other = await mount((id) => {
    missing.push(id)
    return false
  })
  link(other).click()
  assert.deepEqual(missing, ["ses_sidebar"])
  assert.equal(opened().length, 2, "a sender without an Agent Manager tab still goes to the extension")
} finally {
  for (const dispose of disposals) dispose()
  await win.happyDOM.close()
}
