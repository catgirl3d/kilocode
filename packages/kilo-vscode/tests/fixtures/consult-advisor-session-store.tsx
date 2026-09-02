import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { AssistantMessage, Part as SDKPart, ToolPart } from "@kilocode/sdk/v2"

const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  SVGElement: window.SVGElement,
  customElements: window.customElements,
  MessageEvent: window.MessageEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})

const { Show } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionProvider, useSession } = await import("../../webview-ui/src/context/session")
const { post } = await import("../../webview-ui/src/utils/webview-message")
const { Part: MessagePart } = await import("@kilocode/kilo-ui/message-part")

const sessionID = "session-advisor"
const message = {
  id: "message-advisor",
  sessionID,
  role: "assistant",
  parentID: "user-advisor",
  mode: "build",
  agent: "build",
  modelID: "model",
  providerID: "provider",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1 },
} satisfies AssistantMessage

const data = {
  session: [],
  session_status: {},
  session_diff: {},
  message: { [sessionID]: [message] },
  part: {},
}
const root = document.createElement("div")
document.body.append(root)

function Cards() {
  const session = useSession()
  const part = () => session.getParts(message.id).at(0)
  return (
    <>
      <output data-part-id>{part()?.id ?? "none"}</output>
      <Show when={part()}>
        {(value) => (
          <>
            <div data-view="expanded">
              <MessagePart part={value() as unknown as SDKPart} message={message} />
            </div>
            <div data-view="compact">
              <MessagePart part={value() as unknown as SDKPart} message={message} hideDetails />
            </div>
          </>
        )}
      </Show>
    </>
  )
}

const dispose = render(
  () => (
    <StoryProviders data={data} sessionID={sessionID} config={{}} noPadding>
      <SessionProvider>
        <Cards />
      </SessionProvider>
    </StoryProviders>
  ),
  root,
)

function title(view: string) {
  return root.querySelector(`[data-view="${view}"] [data-component="text-shimmer"]`)?.getAttribute("aria-label")
}

function update(part: ToolPart) {
  post({ type: "partUpdated", sessionID, messageID: message.id, part })
}

await window.happyDOM.waitUntilComplete()
update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "running",
    input: {},
    title: "Preparing advisor context",
    metadata: {},
    time: { start: 1 },
  },
})
await window.happyDOM.waitUntilComplete()
assert.equal(root.querySelector("[data-part-id]")?.textContent, "part-advisor")
assert.equal(title("expanded"), "Preparing advisor context")
assert.equal(title("compact"), "Preparing advisor context")

update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "completed",
    input: {},
    output: "guidance",
    title: "Advisor completed",
    metadata: {},
    time: { start: 1, end: 2 },
  },
})
await window.happyDOM.waitUntilComplete()
assert.equal(title("expanded"), "Advisor completed")
assert.equal(title("compact"), "Advisor completed")

dispose()
await window.happyDOM.close()
