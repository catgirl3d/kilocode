/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { Config } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const errors: unknown[] = []
window.addEventListener("error", (event) => {
  if (event instanceof window.ErrorEvent) errors.push(event.error)
})

const api = {
  postMessage: (_message: unknown) => {},
  getState: () => undefined,
  setState: () => {},
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
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
  FocusEvent: window.FocusEvent,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders } = await import("../../webview-ui/src/stories/StoryProviders")
const { ConfigContext } = await import("../../webview-ui/src/context/config")
const { ImageModelsContext } = await import("../../webview-ui/src/context/image-models")
const { deepMerge, stripNulls } = await import("../../webview-ui/src/utils/config-utils")
const ExperimentalTab = (await import("../../webview-ui/src/components/settings/ExperimentalTab")).default

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

function mount() {
  const initial: Partial<Config> = {}
  const [config, setConfig] = createSignal(initial)
  const writes: Partial<Config>[] = []
  const value = {
    config,
    globalConfig: config,
    globalDraft: () => ({}),
    projectDraft: () => ({}),
    globalEffectiveConfig: config,
    projectConfig: config,
    projectBinding: () => undefined,
    collections: () => ({}),
    settings: () => ({}),
    shortcuts: () => ({ bindings: {}, selection: false }),
    features: () => ({ indexing: false, sandboxControls: false, backgroundSubagents: false, speechToText: false }),
    loading: () => false,
    isDirty: () => writes.length > 0,
    saving: () => false,
    discarded: () => 0,
    blocked: () => false,
    saveError: () => null,
    updateConfig: (partial: Partial<Config>) => {
      writes.push(partial)
      setConfig((prev) => stripNulls(deepMerge(prev, partial)))
    },
    updateGlobalConfig: () => {},
    updateProjectConfig: () => {},
    updateSetting: () => {},
    applySetting: () => {},
    saveConfig: () => {},
    discardConfig: () => {},
  }
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders config={{}} noPadding>
        <ConfigContext.Provider value={value}>
          <ImageModelsContext.Provider value={{ models: () => [] }}>
            <ExperimentalTab />
          </ImageModelsContext.Provider>
        </ConfigContext.Provider>
      </StoryProviders>
    ),
    root,
  )
  return { root, writes, dispose }
}

try {
  const view = mount()
  await settle()

  const titles = [...view.root.querySelectorAll<HTMLElement>('[data-slot="settings-row-label-title"]')]
  const row = titles
    .find((entry) => entry.textContent?.trim() === "Task Subagent Model Selection")
    ?.closest<HTMLElement>('[data-slot="settings-row"]')
  assert(row, "Task Subagent Model Selection settings row is rendered")

  const input = row.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  assert(input, "Task Subagent Model Selection switch is rendered")
  input.click()
  await settle()

  const write = view.writes.at(-1)
  assert(write, "toggling the switch writes config")
  assert.equal(write.experimental?.task_model_selection, true, "the switch writes experimental.task_model_selection")
  view.dispose()

  assert.deepEqual(errors, [])
} finally {
  await window.happyDOM.close()
}
