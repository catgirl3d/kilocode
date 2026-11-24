/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { WebviewMessage } from "../../webview-ui/src/types/messages"

const sent: WebviewMessage[] = []
const window = new Window({ url: "http://localhost" })
Object.defineProperty(window, "origin", { value: window.location.origin })
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
  },
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
  HTMLDivElement: window.HTMLDivElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  SVGElement: window.SVGElement,
  ShadowRoot: window.ShadowRoot,
  customElements: window.customElements,
  CSSStyleSheet: window.CSSStyleSheet,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  MessageEvent: window.MessageEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  acquireVsCodeApi: () => api,
})

const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { ConfigProvider, useConfig, saveBound } = await import("../../webview-ui/src/context/config")
const { post } = await import("../../webview-ui/src/utils/webview-message")

const realBound = saveBound.ms
const features = { indexing: false, sandboxControls: false, backgroundSubagents: false, speechToText: false }
const settle = async () => {
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}
const until = async (ready: () => boolean, timeout: number) => {
  const deadline = Date.now() + timeout
  while (!ready()) {
    if (Date.now() > deadline) return false
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 20)
    await promise
  }
  return true
}

const ui: { value?: ReturnType<typeof useConfig> } = {}
const probe = () => {
  if (!ui.value) throw new Error("the config probe has not rendered")
  return ui.value
}
const Probe = () => {
  ui.value = useConfig()
  return null
}

const updates = () =>
  sent.filter(
    (message): message is Extract<WebviewMessage, { type: "updateConfig" }> => message.type === "updateConfig",
  )
const lastUpdate = () => {
  const message = updates().at(-1)
  assert.ok(message, "Expected a posted updateConfig message")
  return message
}

const host = document.createElement("div")
document.body.append(host)
const dispose = render(
  () => (
    <VSCodeProvider>
      <ConfigProvider>
        <Probe />
      </ConfigProvider>
    </VSCodeProvider>
  ),
  host,
)

try {
  await settle()
  post({ type: "extensionDataReady" })
  await settle()

  let failed = 0
  probe().applyConfig({ subagent_model: "kilo/next", subagent_variant: null }, "global", () => {
    failed += 1
  })
  await settle()
  assert.equal(probe().applying(), true, "the quick write keeps the control busy until the host answers")
  const write = lastUpdate()
  assert.equal(write.config?.subagent_model, "kilo/next", "the quick write posts the selected subagent model globally")
  assert.equal(write.projectConfig, undefined, "a global quick write sends no project patch")
  assert.deepEqual(write.globalUnset, [["subagent_variant"]], "the quick write unsets a cleared reasoning effort")
  post({
    type: "configUpdated",
    config: { subagent_model: "kilo/foreign" },
    features,
    requestId: "foreign-request",
  })
  await settle()
  assert.equal(probe().applying(), true, "a foreign config confirmation does not settle the quick write")
  post({ type: "configUpdated", config: { subagent_model: "kilo/next" }, features, requestId: write.requestId })
  await settle()
  assert.equal(probe().applying(), false, "the host confirmation clears the quick write busy state")
  assert.equal(failed, 0, "a confirmed quick write reports no failure")

  probe().applyConfig({ subagent_model: null, subagent_variant: null }, "global")
  await settle()
  const clear = lastUpdate()
  assert.deepEqual(
    clear.globalUnset,
    [["subagent_model"], ["subagent_variant"]],
    "clearing the quick model unsets both keys",
  )
  post({ type: "configUpdated", config: {}, features, requestId: clear.requestId })
  await settle()

  probe().applyConfig({ subagent_model: "kilo/project" }, "project")
  await settle()
  const project = lastUpdate()
  assert.equal(
    project.projectConfig?.subagent_model,
    "kilo/project",
    "a pinned workspace writes the quick subagent model to the project",
  )
  assert.deepEqual(project.config, {}, "a project quick write sends no global patch")
  assert.deepEqual(project.globalUnset, [], "a project quick write sends no global unset")
  post({
    type: "configUpdated",
    config: { subagent_model: "kilo/project" },
    projectConfig: { subagent_model: "kilo/project" },
    features,
    requestId: project.requestId,
  })
  await settle()

  probe().applyConfig({ subagent_model: null, subagent_variant: null }, "project")
  await settle()
  const projectClear = lastUpdate()
  assert.deepEqual(
    projectClear.projectUnset,
    [["subagent_model"], ["subagent_variant"]],
    "clearing a workspace quick model unsets both project keys",
  )
  post({ type: "configUpdated", config: {}, projectConfig: {}, features, requestId: projectClear.requestId })
  await settle()

  let rejected = 0
  let reason: string | undefined
  probe().applyConfig({ subagent_model: "kilo/rejected" }, "global", (message) => {
    rejected += 1
    reason = message
  })
  await settle()
  const rejectWrite = lastUpdate()
  post({ type: "configUpdateFailed", message: "quick write rejected", requestId: rejectWrite.requestId })
  await settle()
  assert.equal(rejected, 1, "a rejected quick write reports the failure")
  assert.equal(reason, "quick write rejected", "a rejected quick write passes the host reason")
  assert.equal(probe().applying(), false, "a rejected quick write clears the busy state")
  assert.equal(probe().saveError(), null, "a quick write failure does not set the Settings save error")

  saveBound.ms = 20
  probe().updateConfig({ model: "draft-model" })
  await settle()
  assert.equal(probe().isDirty(), true, "the late quick failure case starts with a staged Settings draft")
  let unconfirmed = 0
  probe().applyConfig({ subagent_model: "kilo/late" }, "global", () => {
    unconfirmed += 1
  })
  await settle()
  const lateWrite = lastUpdate()
  const stopped = await until(() => probe().applying() === false, 300)
  assert.equal(stopped, true, "the quick write stops waiting at the bound")
  assert.equal(unconfirmed, 1, "an unconfirmed quick write reports the failure")
  post({
    type: "configUpdateFailed",
    message: "late quick failure",
    requestId: lateWrite.requestId,
    completedScopes: ["global"],
  })
  await settle()
  assert.equal(probe().saveError(), null, "a late quick failure does not report on the Settings save bar")
  assert.equal(probe().isDirty(), true, "a late quick failure does not clear the staged Settings draft")
  assert.equal(unconfirmed, 1, "a late quick failure is not reported twice")

  post({ type: "configBindingExpired", reason: "project-changed" })
  await settle()
  assert.equal(probe().blocked(), true, "an expired config binding blocks quick writes")
  const writes = updates().length
  let blockedFailure = 0
  probe().applyConfig({ subagent_model: "kilo/blocked" }, "global", () => {
    blockedFailure += 1
  })
  await settle()
  assert.equal(updates().length, writes, "a blocked quick write posts nothing")
  assert.equal(probe().applying(), false, "a blocked quick write does not claim the control")
  assert.equal(blockedFailure, 0, "a blocked quick write reports no failure")
} finally {
  saveBound.ms = realBound
  dispose()
  await window.happyDOM.close()
}
