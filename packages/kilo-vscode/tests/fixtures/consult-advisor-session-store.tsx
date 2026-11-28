import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { AssistantMessage, Part as SDKPart, ToolPart } from "@kilocode/sdk/v2"

const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
const hostMessages: { type?: string; id?: string; text?: string }[] = []
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
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
  acquireVsCodeApi: () => ({
    postMessage: (message: { type?: string; id?: string; text?: string }) => hostMessages.push(message),
    getState: () => undefined,
    setState: () => {},
  }),
})

const { Show, createSignal } = await import("solid-js")
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
const [closed, setClosed] = createSignal<ToolPart>()
const [closedCompleted, setClosedCompleted] = createSignal<ToolPart>()

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
      <Show when={closed()}>
        {(value) => (
          <div data-view="closed-default">
            <MessagePart part={value() as unknown as SDKPart} message={message} defaultOpen={false} />
          </div>
        )}
      </Show>
      <Show when={closedCompleted()}>
        {(value) => (
          <div data-view="closed-completed">
            <MessagePart part={value() as unknown as SDKPart} message={message} defaultOpen={false} />
          </div>
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

const input = {
  question: "review the rebase plan",
  focus: "plan",
  advisors: ["critic", "security"],
  files: [{ path: "src/app.ts", start: 1, end: 3 }],
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

const trigger = root
  .querySelector<HTMLElement>('[data-view="expanded"] [data-component="tool-trigger"]')
  ?.closest("button")
assert.ok(trigger, "advisor tool trigger did not render")
trigger.click()
await window.happyDOM.waitUntilComplete()

const label = root.querySelector<HTMLElement>('[data-view="expanded"] [data-slot="mcp-section-label"]')
assert.ok(label, "advisor output section did not render")
assert.match(label.textContent ?? "", /Output/)
const copy = label.querySelector<HTMLButtonElement>("button")
assert.ok(copy, "advisor output copy button did not render")

copy.click()
await window.happyDOM.waitUntilComplete()
const clipboard = hostMessages.find((entry) => entry.type === "copyToClipboard")
assert.equal(clipboard?.text, "guidance")

post({ type: "clipboardWriteResult", id: clipboard!.id, ok: true })
await window.happyDOM.waitUntilComplete()
assert.equal(copy.getAttribute("aria-label"), "Copied")

const advisors = () => [
  {
    name: "Critic",
    model: "claude-sonnet-4-5",
    variant: "high",
    status: "done",
    text: "Edge cases in the rebase recovery path look covered.",
  },
  {
    name: "Security",
    model: "gpt-5",
    variant: "medium",
    status: "done",
    text: "No credential leaks found.",
  },
  { name: "Plan review", model: "gemini-pro", variant: "high", status: "waiting" },
]
const warnings = ["requested lines 1-3; supplied 1-2", "   "]
const plan = (status: string) => advisors().map((item) => (item.name === "Plan review" ? { ...item, status } : item))

update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "running",
    input,
    title: "2 of 3 advisors responded",
    metadata: { advisors: advisors(), warnings },
    time: { start: 1 },
  },
})
await window.happyDOM.waitUntilComplete()
assert.equal(title("expanded"), "consult_advisor")
assert.equal(title("compact"), "consult_advisor")

const subtitle = root.querySelector('[data-view="expanded"] [data-slot="basic-tool-tool-subtitle"]')?.textContent
assert.equal(subtitle, "2 of 3 advisors responded")
assert.equal(
  root.querySelectorAll('[data-view="compact"] [data-slot="advisor-card"]').length,
  0,
  "compact view must not render advisor cards",
)
assert.equal(root.querySelector('[data-view="expanded"] [data-slot="mcp-section-label"]')?.textContent, "Input")
assert.match(
  root.querySelector('[data-view="expanded"] [data-component="tool-output"]')?.textContent ?? "",
  /review the rebase plan/,
)

const warningsView = root.querySelectorAll<HTMLElement>('[data-view="expanded"] [data-slot="advisor-warning"]')
assert.equal(warningsView.length, 1, "blank warnings must be filtered")
assert.equal(warningsView[0]?.textContent, "requested lines 1-3; supplied 1-2")

const cards = root.querySelectorAll<HTMLElement>('[data-view="expanded"] [data-slot="advisor-card"]')
assert.equal(cards.length, 3, "advisor cards did not render")
assert.equal(cards[0]?.querySelector('[data-slot="advisor-card-name"]')?.textContent, "Critic")
assert.match(cards[0]?.textContent ?? "", /rebase recovery path/)
assert.equal(cards[1]?.querySelector('[data-slot="advisor-card-name"]')?.textContent, "Security")
assert.equal(cards[0]?.querySelector('[data-slot="advisor-card-model"]')?.textContent, "(claude-sonnet-4-5, high)")
assert.equal(cards[1]?.querySelector('[data-slot="advisor-card-model"]')?.textContent, "(gpt-5, medium)")
assert.equal(cards[2]?.querySelector('[data-slot="advisor-card-model"]')?.textContent, "(gemini-pro, high)")
const waiting = cards[2]?.querySelector<HTMLElement>('[data-component="text-shimmer"]')
assert.equal(waiting?.getAttribute("aria-label"), "Waiting for first response")
assert.equal(cards[2]?.querySelector("button"), null, "waiting advisor must not show copy")

const advisorCopy = cards[0]?.querySelector<HTMLButtonElement>("button")
assert.ok(advisorCopy, "advisor copy button did not render")
hostMessages.length = 0
advisorCopy.click()
await window.happyDOM.waitUntilComplete()
const advisorClipboard = hostMessages.find((entry) => entry.type === "copyToClipboard")
assert.equal(advisorClipboard?.text, "Edge cases in the rebase recovery path look covered.")

const secondCopy = cards[1]?.querySelector<HTMLButtonElement>("button")
assert.ok(secondCopy, "second advisor copy button did not render")
hostMessages.length = 0
secondCopy.click()
await window.happyDOM.waitUntilComplete()
assert.equal(hostMessages.find((entry) => entry.type === "copyToClipboard")?.text, "No credential leaks found.")

for (const [status, label] of [
  ["reasoning", "Advisor is reasoning"],
  ["retrying", "Advisor retrying"],
  ["writing", "Advisor is writing"],
] as const) {
  update({
    id: "part-advisor",
    sessionID,
    messageID: message.id,
    type: "tool",
    callID: "call-advisor",
    tool: "consult_advisor",
    state: {
      status: "running",
      input,
      title: "2 of 3 advisors responded",
      metadata: { advisors: plan(status), warnings },
      time: { start: 1 },
    },
  })
  await window.happyDOM.waitUntilComplete()
  const card = root.querySelector<HTMLElement>(
    `[data-view="expanded"] [data-slot="advisor-card"][data-status="${status}"]`,
  )
  assert.ok(card, `${status} advisor card did not render`)
  assert.equal(card?.querySelector('[data-component="text-shimmer"]')?.getAttribute("aria-label"), label)
}

setClosed({
  id: "part-advisor-closed",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor-closed",
  tool: "consult_advisor",
  state: {
    status: "running",
    input,
    title: "2 of 3 advisors responded",
    metadata: { advisors: advisors(), warnings },
    time: { start: 1 },
  },
})
await window.happyDOM.waitUntilComplete()
const closedCards = root.querySelectorAll<HTMLElement>('[data-view="closed-default"] [data-slot="advisor-card"]')
assert.equal(closedCards.length, 3, "running advisor cards must open even when the caller passes defaultOpen=false")
assert.equal(
  root.querySelector('[data-view="closed-default"] [data-slot="collapsible-trigger"]')?.getAttribute("aria-expanded"),
  "true",
)
assert.match(closedCards[0]?.textContent ?? "", /rebase recovery path/)
assert.ok(closedCards[0]?.querySelector("button"), "closed-default advisor copy missing")

const completeAdvisors = advisors().map((item) =>
  item.name === "Plan review" ? { ...item, status: "done", text: "Plan review guidance." } : item,
)
update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "completed",
    input,
    output: "guidance",
    title: "Advisor completed",
    metadata: {
      advisors: completeAdvisors,
      warnings,
    },
    time: { start: 1, end: 2 },
  },
})
await window.happyDOM.waitUntilComplete()
const doneCards = root.querySelectorAll<HTMLElement>('[data-view="expanded"] [data-slot="advisor-card"]')
assert.equal(doneCards.length, 3, "completed advisor cards did not render")
assert.match(doneCards[2]?.textContent ?? "", /Plan review guidance/)
assert.equal(doneCards[2]?.querySelector('[data-component="text-shimmer"]'), null)
assert.ok(doneCards[2]?.querySelector("button"), "completed card copy missing")
assert.equal(root.querySelectorAll('[data-view="expanded"] [data-slot="advisor-warning"]').length, 1)

setClosedCompleted({
  id: "part-advisor-closed-completed",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor-closed-completed",
  tool: "consult_advisor",
  state: {
    status: "completed",
    input,
    output: "guidance",
    title: "Advisor completed",
    metadata: { advisors: completeAdvisors, warnings },
    time: { start: 1, end: 2 },
  },
})
await window.happyDOM.waitUntilComplete()
assert.equal(
  root.querySelector('[data-view="closed-completed"] [data-slot="collapsible-trigger"]')?.getAttribute("aria-expanded"),
  "false",
  "completed advisor cards must respect defaultOpen=false",
)

update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "completed",
    input,
    output: "guidance",
    title: "Advisor completed",
    metadata: {
      advisors: [
        advisors()[0],
        { name: "Security", model: "gpt-5", variant: "medium", status: "failed", error: "429 usage limit" },
        {
          name: "Plan review",
          model: "gemini-pro",
          variant: "high",
          status: "unavailable",
          reason: "Model not configured",
        },
      ],
    },
    time: { start: 1, end: 2 },
  },
})
await window.happyDOM.waitUntilComplete()
const failedCard = root.querySelector<HTMLElement>(
  '[data-view="expanded"] [data-slot="advisor-card"][data-status="failed"]',
)
assert.ok(failedCard, "failed advisor card did not render")
assert.equal(failedCard?.querySelector('[data-slot="advisor-card-detail"]')?.textContent, "429 usage limit")
assert.equal(failedCard?.querySelector("button"), null)
const unavailableCard = root.querySelector<HTMLElement>(
  '[data-view="expanded"] [data-slot="advisor-card"][data-status="unavailable"]',
)
assert.ok(unavailableCard, "unavailable advisor card did not render")
assert.equal(unavailableCard?.querySelector('[data-slot="advisor-card-detail"]')?.textContent, "Model not configured")
assert.equal(
  root.querySelectorAll('[data-view="expanded"] [data-slot="advisor-card"] [data-component="text-shimmer"]').length,
  0,
  "terminal cards must not shimmer",
)

update({
  id: "part-advisor",
  sessionID,
  messageID: message.id,
  type: "tool",
  callID: "call-advisor",
  tool: "consult_advisor",
  state: {
    status: "error",
    input,
    error: "Tool execution aborted",
    title: "Advisor cancelled",
    metadata: {
      advisors: [advisors()[0], { name: "Security", model: "gpt-5", variant: "medium", status: "reasoning" }],
      interrupted: true,
    },
    time: { start: 1, end: 2 },
  },
} as unknown as ToolPart)
await window.happyDOM.waitUntilComplete()
const stoppedCard = root.querySelector<HTMLElement>(
  '[data-view="expanded"] [data-slot="advisor-card"][data-status="reasoning"]',
)
assert.ok(stoppedCard, "stopped advisor card did not render")
assert.equal(stoppedCard?.querySelector('[data-component="text-shimmer"]'), null)
assert.equal(stoppedCard?.querySelector('[data-slot="advisor-card-detail"]')?.textContent, "Advisor is reasoning")
assert.equal(
  root.querySelector('[data-view="expanded"] [data-slot="basic-tool-tool-subtitle"]')?.textContent,
  "Advisor cancelled",
)

dispose()
await window.happyDOM.close()
