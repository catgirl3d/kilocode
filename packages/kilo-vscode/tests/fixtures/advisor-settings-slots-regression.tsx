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
const { deepMerge, stripNulls } = await import("../../webview-ui/src/utils/config-utils")
const { flattenModels } = await import("../../webview-ui/src/context/provider-utils")
const AdvisorSettingsSection = (await import("../../webview-ui/src/components/settings/AdvisorSettingsSection")).default

const MODEL = "kilo/anthropic/claude-sonnet-4-6"
const OTHER = "kilo/anthropic/claude-opus-4-6"
const NAME_ERROR = "Use up to 32 lowercase letters, numbers, hyphens or underscores, starting with a letter or number."
const EMPTY_ERROR = "Enter a name to save this advisor."

const VARIANTS = { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } }
const MODELS = flattenModels({
  kilo: {
    id: "kilo",
    name: "Kilo",
    models: {
      "anthropic/claude-sonnet-4-6": {
        id: "anthropic/claude-sonnet-4-6",
        name: "Anthropic: Claude Sonnet 4.6",
        variants: VARIANTS,
      },
      "anthropic/claude-opus-4-6": {
        id: "anthropic/claude-opus-4-6",
        name: "Anthropic: Claude Opus 4.6",
        variants: VARIANTS,
      },
    },
  },
} as never)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

/** Mounts the section with a config context that records every partial and applies it like the real provider. */
function mount(initial: Config) {
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
      <StoryProviders config={{}} noPadding models={MODELS}>
        <ConfigContext.Provider value={value}>
          <AdvisorSettingsSection />
        </ConfigContext.Provider>
      </StoryProviders>
    ),
    root,
  )
  return { root, writes, dispose }
}

type View = ReturnType<typeof mount>

function slots(view: View) {
  return [...view.root.querySelectorAll<HTMLElement>(".settings-advisor-slot")]
}

function slot(view: View, index: number) {
  const found = slots(view).at(index)
  assert(found, `slot ${index} is rendered`)
  return found
}

function field(node: HTMLElement, label: string) {
  const wrapper = [...node.querySelectorAll<HTMLElement>('[data-component="input"]')].find(
    (entry) => entry.querySelector('[data-slot="input-label"]')?.textContent === label,
  )
  const input = wrapper?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-slot="input-input"]')
  const content = wrapper?.closest<HTMLElement>('[data-slot="collapsible-content"]')
  assert(wrapper && input && content?.hasAttribute("data-expanded"), `slot exposes the open ${label} field`)
  return { wrapper, input }
}

function error(node: HTMLElement, label: string) {
  return field(node, label).wrapper.querySelector('[data-slot="input-error"]')?.textContent
}

async function type(node: HTMLElement, label: string, text: string) {
  const input = field(node, label).input
  input.focus()
  input.value = text
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()
}

async function blur(node: HTMLElement, label: string) {
  field(node, label).input.blur()
  await settle()
}

function button(node: HTMLElement, label: string) {
  return [...node.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  )
}

async function click(node: HTMLElement, label: string) {
  const found = button(node, label)
  assert(found, `${label} button is rendered`)
  found.focus()
  found.click()
  await settle()
}

async function toggle(view: View) {
  const input = view.root.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  assert(input, "enable switch is rendered")
  input.click()
  await settle()
}

function written(view: View) {
  const last = view.writes.at(-1)
  assert(last, "a config write happened")
  return last.experimental?.advisors
}

async function chooseModel(
  node: HTMLElement,
  target = { query: "Claude Sonnet", key: MODEL, label: "Select: Anthropic: Claude Sonnet 4.6" },
) {
  const trigger = [...node.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.getAttribute("aria-label")?.startsWith("Advisor Model:"),
  )
  assert(trigger, "the advisor model selector is rendered")
  trigger.click()
  await settle()

  const search = [...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find(
    (entry) => entry.getAttribute("aria-expanded") === "true",
  )
  assert(search, "the open model selector exposes its search field")
  search.value = target.query
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()

  const item = document.querySelector<HTMLElement>(`[data-key="model:${target.key}"]`)
  assert(item, "the mock provider model is rendered in the real selector")
  item.click()
  await settle()

  const select = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === target.label,
  )
  // Picking the already selected model commits on the item click; otherwise the
  // selector stays open with a confirm action.
  if (select) {
    select.click()
    await settle()
  }
}

function moveUp(node: HTMLElement) {
  const up = button(node, "Move advisor up")
  assert(up, "the slot offers to move up")
  return up
}

try {
  // A 33-character name fails the format rule; 32 characters is the accepted limit.
  {
    const view = mount({ experimental: { advisors: [{ name: "x".repeat(33), model: MODEL }] } })
    await settle()
    assert.equal(error(slot(view, 0), "Name"), NAME_ERROR, "a 33-character name shows the format error")
    assert.equal(view.writes.length, 0, "an invalid saved name does not write config")
    view.dispose()

    const ok = mount({
      experimental: { advisors: [{ name: "x".repeat(32), description: "At the limit", model: MODEL }] },
    })
    await settle()
    assert.equal(error(slot(ok, 0), "Name"), undefined, "a 32-character name is accepted")
    ok.dispose()
  }

  // The default slot cannot move down while it lacks a role prompt, even with a description.
  {
    const view = mount({
      experimental: {
        advisors: [
          { name: "a", description: "First description", model: MODEL },
          { name: "b", description: "Second description", prompt: "Second role", model: MODEL },
        ],
      },
    })
    await settle()
    assert.equal(
      moveUp(slot(view, 1)).hasAttribute("disabled"),
      true,
      "moving up is locked while the default has no role prompt",
    )
    await type(slot(view, 0), "Role prompt (optional)", "First role")
    await blur(slot(view, 0), "Role prompt (optional)")
    assert.equal(moveUp(slot(view, 1)).hasAttribute("disabled"), false, "a complete default unlocks the move")
    await click(slot(view, 1), "Move advisor up")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["b", "a"],
      "the completed default can move down",
    )
    view.dispose()
  }

  // The default slot cannot move down while it lacks a description, even with a role prompt.
  {
    const view = mount({
      experimental: {
        advisors: [
          { name: "a", prompt: "First role", model: MODEL },
          { name: "b", description: "Second description", prompt: "Second role", model: MODEL },
        ],
      },
    })
    await settle()
    assert.equal(
      moveUp(slot(view, 1)).hasAttribute("disabled"),
      true,
      "moving up is locked while the default has no description",
    )
    await type(slot(view, 0), "Description (optional)", "First description")
    assert.equal(moveUp(slot(view, 1)).hasAttribute("disabled"), false, "a complete default unlocks the move")
    view.dispose()
  }

  // Changing the model keeps the saved reasoning variant when the new model offers it.
  {
    const view = mount({
      experimental: {
        advisors: [{ name: "saved", description: "Keep", prompt: "Role", model: MODEL, variant: "high" }],
      },
    })
    await settle()
    await chooseModel(slot(view, 0), {
      query: "Claude Opus",
      key: OTHER,
      label: "Select: Anthropic: Claude Opus 4.6",
    })
    await type(slot(view, 0), "Description (optional)", "Keep2")
    assert.deepEqual(
      written(view)?.at(0),
      { name: "saved", description: "Keep2", prompt: "Role", model: OTHER, variant: "high" },
      "the model change preserves the saved variant",
    )
    view.dispose()
  }

  // Saved values beyond the stored limits are clamped on the next write.
  {
    const view = mount({
      experimental: { advisors: [{ name: "trunc", description: "d".repeat(300), model: MODEL }] },
    })
    await settle()
    await type(slot(view, 0), "Name", "trunc2")
    assert.equal(written(view)?.at(0)?.description?.length, 200, "a 300-character description is stored as 200")
    assert.equal(written(view)?.at(0)?.description, "d".repeat(200), "the first 200 characters are kept")
    view.dispose()

    const long = mount({
      experimental: { advisors: [{ name: "longp", prompt: "p".repeat(20_001), model: MODEL }] },
    })
    await settle()
    await type(slot(long, 0), "Name", "longp2")
    assert.equal(written(long)?.at(0)?.prompt?.length, 20_000, "a 20001-character role prompt is stored as 20000")
    long.dispose()
  }

  // Consecutive spaces collapse into one hyphen in the stored name.
  {
    const view = mount({})
    await settle()
    await toggle(view)
    await click(slot(view, 0), "Customize")
    await chooseModel(slot(view, 0))
    await type(slot(view, 0), "Name", "a  b")
    assert.equal(written(view)?.at(0)?.name, "a-b", "consecutive spaces become a single hyphen")
    view.dispose()
  }

  // A later slot with an empty name reports the dedicated empty-name error.
  {
    const view = mount({})
    await settle()
    await toggle(view)
    await click(view.root, "Add advisor")
    assert.equal(error(slot(view, 1), "Name"), EMPTY_ERROR, "an empty name shows the empty-name error")
    view.dispose()
  }

  assert.deepEqual(errors, [])
} finally {
  await window.happyDOM.close()
}
