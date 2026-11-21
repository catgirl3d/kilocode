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
const { mergeScopedConfig } = await import("../../webview-ui/src/utils/config-utils")
const ExperimentalTab = (await import("../../webview-ui/src/components/settings/ExperimentalTab")).default

const REDACT_TITLE = "Redact recognizable secrets before sending"
const PRUNER_TITLE = "SWE-Pruner"

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

function mount(options: { config?: Config; global?: Config } = {}) {
  const [config, setConfig] = createSignal<Config>(options.config ?? {})
  const [globalConfig, setGlobalConfig] = createSignal<Config>(options.global ?? {})
  const writes: Partial<Config>[] = []
  const globalWrites: Partial<Config>[] = []
  const value = {
    config,
    globalConfig,
    globalDraft: () => ({}),
    projectDraft: () => ({}),
    globalEffectiveConfig: globalConfig,
    projectConfig: () => ({}),
    projectBinding: () => undefined,
    collections: () => ({}),
    settings: () => ({}),
    shortcuts: () => ({ bindings: {}, selection: false }),
    features: () => ({ indexing: false, sandboxControls: false, backgroundSubagents: false, speechToText: false }),
    loading: () => false,
    isDirty: () => writes.length > 0 || globalWrites.length > 0,
    saving: () => false,
    discarded: () => 0,
    blocked: () => false,
    saveError: () => null,
    updateConfig: (partial: Partial<Config>) => {
      writes.push(partial)
      setConfig((prev) => mergeScopedConfig(prev, partial))
    },
    updateGlobalConfig: (partial: Partial<Config>) => {
      globalWrites.push(partial)
      setGlobalConfig((prev) => mergeScopedConfig(prev, partial))
    },
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
  return { root, writes, globalWrites, dispose }
}

function rowSwitch(root: HTMLElement, title: string) {
  const titles = [...root.querySelectorAll<HTMLElement>('[data-slot="settings-row-label-title"]')]
  const row = titles
    .find((entry) => entry.textContent?.trim() === title)
    ?.closest<HTMLElement>('[data-slot="settings-row"]')
  assert(row, `${title} settings row is rendered`)
  const input = row.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  assert(input, `${title} switch is rendered`)
  return input
}

// The hidden Kobalte input does not toggle its checked state in happy-dom on click,
// so drive the visible control the same way a user click does.
function toggle(input: HTMLInputElement) {
  const control = input.closest('[data-component="switch"]')?.querySelector<HTMLElement>('[data-slot="switch-control"]')
  assert(control, "switch control is rendered")
  control.click()
}

try {
  // A project-level false must not turn the personal setting off.
  const scoped = mount({
    config: { experimental: { redact_secrets: false } },
  })
  await settle()
  assert.equal(
    rowSwitch(scoped.root, REDACT_TITLE).checked,
    true,
    "defaults on when the global value is absent even if the project config sets false",
  )

  // Another experimental toggle must not promote the project value into the global config.
  toggle(rowSwitch(scoped.root, PRUNER_TITLE))
  await settle()
  const experimentalWrite = scoped.writes.at(-1)?.experimental
  assert(experimentalWrite, "the SWE-Pruner switch writes experimental config")
  assert.equal(experimentalWrite.swe_pruner, true, "the SWE-Pruner switch writes its own key")
  assert.equal("redact_secrets" in experimentalWrite, false, "the SWE-Pruner switch does not send redact_secrets")
  assert.equal(scoped.globalWrites.length, 0, "the SWE-Pruner switch does not write the global config")
  assert.equal(rowSwitch(scoped.root, REDACT_TITLE).checked, true, "the protection stays on")
  scoped.dispose()

  // Our switch writes the personal setting and turns the protection off.
  const toggled = mount({
    config: { experimental: { redact_secrets: false } },
  })
  await settle()
  toggle(rowSwitch(toggled.root, REDACT_TITLE))
  await settle()
  const globalWrite = toggled.globalWrites.at(-1)?.experimental
  assert(globalWrite, "the redact switch writes experimental config")
  assert.equal(globalWrite.redact_secrets, false, "the redact switch writes redact_secrets to the global config")
  assert.equal(toggled.writes.length, 0, "the redact switch does not write the merged config")
  assert.equal(rowSwitch(toggled.root, REDACT_TITLE).checked, false, "the redact switch turns off")
  toggled.dispose()

  // Reloading with the saved global value keeps the protection off.
  const reloaded = mount({
    config: { experimental: { redact_secrets: false } },
    global: { experimental: { redact_secrets: false } },
  })
  await settle()
  assert.equal(rowSwitch(reloaded.root, REDACT_TITLE).checked, false, "a saved global false stays off after reload")

  // A defined global value is carried by other experimental toggles so a save cannot drop it.
  toggle(rowSwitch(reloaded.root, PRUNER_TITLE))
  await settle()
  assert.equal(
    reloaded.writes.at(-1)?.experimental?.redact_secrets,
    false,
    "another experimental toggle preserves the defined global value",
  )
  reloaded.dispose()

  // No stored global value at all keeps the protection on.
  const fresh = mount()
  await settle()
  assert.equal(rowSwitch(fresh.root, REDACT_TITLE).checked, true, "defaults on when the global config has no value")
  fresh.dispose()

  assert.deepEqual(errors, [])
} finally {
  await window.happyDOM.close()
}
