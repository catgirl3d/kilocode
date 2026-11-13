import assert from "node:assert/strict"
import type { JSX } from "solid-js"
import type { Part, ToolPart } from "@kilocode/sdk/v2"
import { harness } from "./comment-harness"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

const { mount, root, wait } = await harness<{ type: string }>()

// Every outgoing webview message lands here, including revertSession.
const sent: WebviewMessage[] = []
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
  },
  getState: () => undefined,
  setState: () => {},
}
Object.assign(globalThis, { acquireVsCodeApi: () => api })

// Registered before any provider mounts, so this listener runs ahead of the
// capture listener VSCodeProvider installs with protect().
const windowTypes: string[] = []
window.addEventListener(
  "message",
  (event) => {
    const data = event.data as { type?: string } | undefined
    windowTypes.push(data?.type ?? "")
  },
  true,
)

const { QuestionRevert, revertible } = await import("../../webview-ui/src/components/chat/QuestionRevert")
const { ServerProvider } = await import("../../webview-ui/src/context/server")
const { ProviderProvider } = await import("../../webview-ui/src/context/provider")
const { ConfigProvider } = await import("../../webview-ui/src/context/config")
const { NotificationsProvider } = await import("../../webview-ui/src/context/notifications")
const { SessionProvider, useSession } = await import("../../webview-ui/src/context/session")
const { post } = await import("../../webview-ui/src/utils/webview-message")

const ref = { value: undefined as ReturnType<typeof useSession> | undefined }
const Probe = () => {
  ref.value = useSession()
  return null
}
const session = () => {
  const value = ref.value
  assert(value)
  return value
}

// The providers build their children inside the tree, so each view stays a function.
const shell = (children: () => JSX.Element) => (
  <ServerProvider>
    <ProviderProvider>
      <ConfigProvider>
        <NotificationsProvider>
          <SessionProvider>
            <Probe />
            {children()}
          </SessionProvider>
        </NotificationsProvider>
      </ConfigProvider>
    </ProviderProvider>
  </ServerProvider>
)

const sid = "ses_question"
const stamp = "2026-01-01T00:00:00.000Z"
const info = (id: string) => ({ id, title: id, createdAt: stamp, updatedAt: stamp })
const model = { providerID: "kilo", modelID: "fixture" }
const user = (id: string) => ({ id, sessionID: sid, role: "user", model, createdAt: stamp })
const reply = (id: string) => ({
  id,
  sessionID: sid,
  role: "assistant",
  createdAt: stamp,
  time: { created: 1, completed: 2 },
})
const emit = async (data: { type: string } & Record<string, unknown>) => {
  post(structuredClone(data))
  await wait()
}
const reverts = () => sent.filter((item) => item.type === "revertSession")

type ToolState = ToolPart["state"]
const finished: ToolState = {
  status: "completed",
  input: {},
  output: "",
  title: "question",
  metadata: {},
  time: { start: 1, end: 2 },
}
const running: ToolState = { status: "running", input: {}, time: { start: 1 } }
const waiting: ToolState = { status: "pending", input: {}, raw: "" }
const failed: ToolState = { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } }
const tool = (name: string, state: ToolState): Part => ({
  id: `prt_${name}`,
  sessionID: sid,
  messageID: "msg_a",
  type: "tool",
  callID: `call_${name}`,
  tool: name,
  state,
})
const plain: Part = { id: "prt_text", sessionID: sid, messageID: "msg_a", type: "text", text: "Answered" }

{
  const dispose = mount(() => shell(() => null))
  try {
    await wait()
    await emit({ type: "sessionCreated", session: info(sid) })
    session().setCurrentSessionID(sid)

    // a. Only a completed question tool part can be reverted to.
    assert.equal(revertible(tool("question", finished)), true, "a completed question can be reverted to")
    assert.equal(revertible(tool("question", running)), false, "a running question cannot")
    assert.equal(revertible(tool("question", waiting)), false, "a pending question cannot")
    assert.equal(revertible(tool("question", failed)), false, "an errored question cannot")
    assert.equal(revertible(tool("bash", finished)), false, "a completed non-question tool cannot")
    assert.equal(revertible(plain), false, "a text part cannot")

    // b. A question revert carries the part and leaves the composer draft alone.
    sent.splice(0)
    windowTypes.splice(0)
    session().revertSession("msg_a", "prt_q")
    await wait()
    assert.deepEqual(reverts(), [{ type: "revertSession", sessionID: sid, messageID: "msg_a", partID: "prt_q" }])
    assert.equal(windowTypes.includes("setChatBoxMessage"), false, "a question revert must not overwrite the composer")

    // c. A prompt revert (no part) still restores the composer draft.
    sent.splice(0)
    windowTypes.splice(0)
    session().revertSession("msg_u")
    await wait()
    assert.deepEqual(reverts(), [{ type: "revertSession", sessionID: sid, messageID: "msg_u", partID: undefined }])
    assert.equal(windowTypes.includes("setChatBoxMessage"), true, "a prompt revert restores the composer draft")

    // d. revertedCount counts the boundary message itself, then each user message after it.
    await emit({ type: "messagesLoaded", sessionID: sid, messages: [user("u1"), reply("a1")] })
    await emit({
      type: "sessionUpdated",
      session: { ...info(sid), revert: { messageID: "a1", partID: "prt_a1" } },
    })
    assert.equal(session().revertedCount(), 1, "an assistant boundary counts as one")
    await emit({ type: "sessionUpdated", session: { ...info(sid), revert: { messageID: "u1" } } })
    assert.equal(session().revertedCount(), 1, "a user boundary counts as one")
    await emit({ type: "messagesLoaded", sessionID: sid, messages: [user("u1"), reply("a1"), user("u2")] })
    await emit({
      type: "sessionUpdated",
      session: { ...info(sid), revert: { messageID: "a1", partID: "prt_a1" } },
    })
    assert.equal(session().revertedCount(), 2, "a later user message counts after an assistant boundary")
  } finally {
    dispose()
  }
}

{
  // e. The rendered button reverts when idle and stays disabled while the agent is busy.
  const release = mount(() => shell(() => <QuestionRevert messageID="msg_a" partID="prt_q" />))
  try {
    await wait()
    await emit({ type: "sessionCreated", session: info(sid) })
    session().setCurrentSessionID(sid)
    const button = () => {
      const node = root.querySelector<HTMLButtonElement>('[data-slot="question-revert"] button')
      assert(node, "the question revert button renders")
      return node
    }
    assert.equal(button().textContent?.trim(), "Revert to here")

    sent.splice(0)
    button().click()
    await wait()
    assert.deepEqual(reverts(), [{ type: "revertSession", sessionID: sid, messageID: "msg_a", partID: "prt_q" }])

    sent.splice(0)
    await emit({ type: "sessionStatus", sessionID: sid, status: "busy" })
    assert.equal(button().hasAttribute("disabled"), true, "the button is disabled while the agent is busy")
    button().click()
    await wait()
    assert.deepEqual(reverts(), [], "a busy click sends nothing")
    button().dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait()
    assert.deepEqual(reverts(), [], "a click dispatched past the disabled state still sends nothing")

    await emit({ type: "sessionStatus", sessionID: sid, status: "idle" })
    assert.equal(button().hasAttribute("disabled"), false, "the button is enabled again once idle")
    sent.splice(0)
    button().click()
    await wait()
    assert.equal(reverts().length, 1, "an idle click sends one revert again")
  } finally {
    release()
  }
}
