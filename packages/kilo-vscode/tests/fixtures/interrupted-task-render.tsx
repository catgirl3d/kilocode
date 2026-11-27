import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { AssistantMessage, ToolPart } from "@kilocode/sdk/v2"

const win = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window: win,
  document: win.document,
  customElements: win.customElements,
  navigator: win.navigator,
  Node: win.Node,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  SVGElement: win.SVGElement,
  MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver,
  CustomEvent: win.CustomEvent,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win),
})

const { render } = await import("solid-js/web")
// A linked worktree shares node_modules with the main checkout, so the package
// specifier would resolve to the main checkout's kilo-ui source. Use this tree.
const { Part, ToolRegistry } = await import("../../../kilo-ui/src/components/message-part")

ToolRegistry.register({
  name: "task",
  render: (props) => (
    <div
      data-testid="task-card"
      data-status={props.status}
      data-interrupted={
        (props.metadata as { interrupted?: unknown } | undefined)?.interrupted === true ? "true" : undefined
      }
    />
  ),
})

const message: AssistantMessage = {
  id: "assistant",
  sessionID: "session",
  role: "assistant",
  parentID: "prompt",
  modelID: "fixture",
  providerID: "fixture",
  mode: "code",
  agent: "code",
  path: { cwd: "/project", root: "/project" },
  time: { created: 1, completed: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

function part(tool: string, interrupted: boolean): ToolPart {
  return {
    id: `part-${tool}-${interrupted ? "interrupted" : "failed"}`,
    sessionID: message.sessionID,
    messageID: message.id,
    type: "tool",
    tool,
    callID: `call-${tool}`,
    state: {
      status: "error",
      input: tool === "task" ? { description: "Finish tool-history report", subagent_type: "general" } : {},
      error: "Tool execution aborted",
      metadata: interrupted ? { sessionId: "child", interrupted: true } : { sessionId: "child" },
      time: { start: 1, end: 2 },
    },
  }
}

function mount(value: ToolPart) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(() => <Part part={value} message={message} defaultOpen={false} />, root)
  return { root, dispose }
}

const settle = async () => {
  await Promise.resolve()
  await win.happyDOM.waitUntilComplete()
}

try {
  const stopped = mount(part("task", true))
  const failed = mount(part("task", false))
  const bash = mount(part("bash", true))
  await settle()

  const card = stopped.root.querySelector<HTMLElement>('[data-testid="task-card"]')
  assert.ok(card, "an interrupted task keeps its card")
  assert.equal(card.getAttribute("data-status"), "error", "the task card keeps the error status")
  assert.equal(card.getAttribute("data-interrupted"), "true", "the task card receives interrupted metadata")
  assert.equal(
    stopped.root.querySelector('[data-component="tool-error"]'),
    null,
    "an interrupted task does not fall back to the generic error card",
  )

  assert.equal(
    failed.root.querySelector('[data-testid="task-card"]'),
    null,
    "a task error without an interruption still uses the error card",
  )
  assert.ok(failed.root.querySelector('[data-component="tool-error"]'), "a task error shows the error card")

  assert.equal(
    bash.root.querySelector('[data-testid="task-card"]'),
    null,
    "an interrupted non-task tool never uses the task card",
  )
  assert.ok(
    bash.root.querySelector('[data-component="tool-error"]'),
    "an interrupted non-task tool keeps the generic error card",
  )

  stopped.dispose()
  failed.dispose()
  bash.dispose()
} finally {
  win.close()
}
