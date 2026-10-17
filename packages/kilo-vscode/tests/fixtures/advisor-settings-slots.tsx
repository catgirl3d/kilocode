/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { AdvisorSlot, Config } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const errors: unknown[] = []
window.addEventListener("error", (event) => {
  if (event instanceof window.ErrorEvent) errors.push(event.error)
})

const outbound: unknown[] = []
const api = {
  postMessage: (message: unknown) => outbound.push(message),
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
const { useConfig } = await import("../../webview-ui/src/context/config")
const { deepMerge, stripNulls } = await import("../../webview-ui/src/utils/config-utils")
const { post } = await import("../../webview-ui/src/utils/webview-message")
const AdvisorSettingsSection = (await import("../../webview-ui/src/components/settings/AdvisorSettingsSection")).default
const Settings = (await import("../../webview-ui/src/components/settings/Settings")).default

const MODEL = "kilo/anthropic/claude-sonnet-4-6"
const BUILTIN_ROLE_HELP = "Uses the built-in engineering advisor role. No custom prompt is needed."
const DISABLED = { experimental: { advisors: null, advisor_model: null, advisor_variant: null } }
const FEATURES = { indexing: false, sandboxControls: false, backgroundSubagents: false, speechToText: false }

const ConfigProbe = () => {
  const { config, isDirty, saving } = useConfig()
  return (
    <output data-testid="config-state">
      {JSON.stringify({ config: config(), dirty: isDirty(), saving: saving() })}
    </output>
  )
}

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
      <StoryProviders config={{}} noPadding>
        <ConfigContext.Provider value={value}>
          <AdvisorSettingsSection />
        </ConfigContext.Provider>
      </StoryProviders>
    ),
    root,
  )
  return { root, writes, config, setConfig, dispose }
}

function mountReal() {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <StoryProviders noPadding>
        <Settings tab="models" />
        <ConfigProbe />
      </StoryProviders>
    ),
    root,
  )
  return { root, dispose }
}

type View = ReturnType<typeof mount>
type RootView = { root: HTMLElement }

function slots(view: RootView) {
  return [...view.root.querySelectorAll<HTMLElement>(".settings-advisor-slot")]
}

function slot(view: RootView, index: number) {
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

function help(node: HTMLElement, label: string) {
  return field(node, label).wrapper.querySelector('[data-slot="input-description"]')?.textContent
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

async function customize(node: HTMLElement) {
  await click(node, "Customize")
}

async function toggle(view: RootView) {
  const input = view.root.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  assert(input, "enable switch is rendered")
  input.click()
  await settle()
}

function press(node: HTMLElement, type: string) {
  node.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: "mouse",
    }) as unknown as Event,
  )
}

async function template(node: HTMLElement, label: string) {
  const trigger = button(node, "Template")
  assert(trigger, "slot exposes the template picker")
  press(trigger, "pointerdown")
  await settle()
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "template picker opens")
  const id = trigger.getAttribute("aria-controls")
  const menu = id ? document.getElementById(id) : null
  assert(menu, "template picker renders its menu")
  const item = [...menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((entry) =>
    entry.textContent?.includes(label),
  )
  assert(item, `template picker offers ${label}`)
  item.dispatchEvent(
    new window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
  )
  await settle()
}

function written(view: View) {
  const last = view.writes.at(-1)
  assert(last, "a config write happened")
  return last.experimental?.advisors
}

function names(view: RootView) {
  return slots(view).map((node) => {
    const title = node.querySelector<HTMLElement>(".settings-advisor-slot-title")
    assert(title, "slot exposes its observable name header")
    return title.textContent?.trim() ?? ""
  })
}

function role(node: HTMLElement) {
  const summary = node.querySelector<HTMLElement>(".settings-advisor-slot-role")
  assert(summary, "slot exposes its role summary")
  return summary.textContent?.trim()
}

function state(view: RootView) {
  const output = view.root.querySelector<HTMLOutputElement>('[data-testid="config-state"]')
  assert(output, "real ConfigProvider exposes its current state")
  return JSON.parse(output.textContent ?? "{}") as { config: Config; dirty: boolean; saving: boolean }
}

function message(type: "configLoaded" | "configUpdated", config: Config) {
  post({ type, config, features: FEATURES })
}

function sent(type: string) {
  return outbound.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === type,
  )
}

async function changeUnrelated(view: RootView) {
  const row = view.root.querySelector<HTMLElement>(
    '[data-slot="settings-row"][data-search-label="Hide Prompt-Training Models"]',
  )
  assert(row, "the Hide Prompt-Training Models settings row is rendered")
  const found = row.querySelector<HTMLInputElement>('[data-slot="switch-input"]')
  assert(found, "the Hide Prompt-Training Models switch is rendered")
  found.click()
  await settle()
  assert.equal(
    state(view).config.hide_prompt_training_models,
    true,
    "the unrelated setting changes in the real provider",
  )
}

async function chooseModel(node: HTMLElement) {
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
  search.value = "Claude Sonnet"
  search.dispatchEvent(new window.InputEvent("input", { bubbles: true }) as unknown as Event)
  await settle()

  const item = document.querySelector<HTMLElement>('[data-key="model:kilo/anthropic/claude-sonnet-4-6"]')
  assert(item, "the mock provider model is rendered in the real selector")
  item.click()
  await settle()

  const select = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === "Select: Anthropic: Claude Sonnet 4.6",
  )
  assert(select, "the real model selector exposes its select action")
  select.click()
  await settle()
}

async function chooseVariant(node: HTMLElement) {
  const trigger = button(node, "Reasoning effort")
  assert(trigger, "the advisor reasoning selector is rendered")
  trigger.click()
  await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent?.trim() === "High",
  )
  assert(option, "the real reasoning selector exposes the high variant")
  option.click()
  await settle()
}

function assertLegacyNulled(view: View) {
  for (const write of view.writes) {
    assert.equal(write.experimental?.advisor_model, null, "every write clears the legacy advisor_model")
    assert.equal(write.experimental?.advisor_variant, null, "every write clears the legacy advisor_variant")
  }
}

try {
  // Legacy config: one slot named "advisor", migrated by the first real write.
  {
    const view = mount({ experimental: { advisor_model: MODEL, advisor_variant: "high" } })
    await settle()
    assert.equal(slots(view).length, 1, "legacy advisor renders as one slot")
    assert.deepEqual(names(view), ["advisor"], "legacy slot is named advisor")
    assert.ok(slot(view, 0).textContent?.includes("Default"), "the first slot is labelled as the default")
    assert.equal(view.writes.length, 0, "rendering a legacy config does not write")

    await customize(slot(view, 0))
    await type(slot(view, 0), "Description (optional)", "Second opinions")
    assert.deepEqual(view.writes.at(-1), {
      experimental: {
        advisors: [{ name: "advisor", description: "Second opinions", model: MODEL, variant: "high" }],
        advisor_model: null,
        advisor_variant: null,
      },
    })
    assert.equal(view.config().experimental?.advisor_model, undefined, "legacy model is gone after migration")

    // Adding slots stops at three; empty slots are drafts and are not written.
    const before = view.writes.length
    await click(view.root, "Add advisor")
    await click(view.root, "Add advisor")
    assert.equal(slots(view).length, 3, "three slots are rendered")
    assert.equal(button(view.root, "Add advisor"), undefined, "add button is hidden at the limit")
    assert.equal(view.writes.length, before, "empty draft slots are not written")
    assert.ok(
      slot(view, 1).textContent?.includes("Choose a model to save this advisor."),
      "draft slot asks for a model",
    )

    // A template fills prompt and description, and keeps an existing name.
    await template(slot(view, 0), "Critic")
    assert.equal(button(slot(view, 0), "Customize")?.getAttribute("aria-expanded"), "true")
    const critic = written(view)?.[0]
    assert.equal(critic?.name, "advisor", "template keeps the existing name")
    assert.ok(critic?.prompt?.startsWith("You are a senior reviewer acting as a critic."), "template fills the prompt")
    assert.equal(critic?.description, "Finds bugs, regressions and weak reasoning in a proposed change or answer.")
    assert.equal(
      field(slot(view, 0), "Role prompt (optional)").input.value,
      critic?.prompt,
      "prompt field shows the template",
    )

    // On an unnamed draft slot the template also fills the name, without writing the model-less slot.
    const count = view.writes.length
    await template(slot(view, 1), "Security")
    assert.deepEqual(names(view), ["advisor", "security", "New advisor"], "template names an unnamed slot")
    assert.equal(view.writes.length, count, "a slot without a model is not written")
    assert.equal(role(slot(view, 1)), "Role: Custom", "a template supplies the role a later slot requires")
    assert.equal(role(slot(view, 2)), "Role: Not set", "a later slot without a role does not claim the standard role")

    // Disabling removes the slots and writes the disable payload.
    await toggle(view)
    assert.equal(slots(view).length, 0, "disabling hides the slots")
    assert.deepEqual(view.writes.at(-1), DISABLED)
    assert.equal(view.config().experimental?.advisors, undefined, "disabled config has no advisors")
    assertLegacyNulled(view)
    view.dispose()
  }

  // Three saved slots: validation, reorder, delete, prompt blur, and reload on external changes.
  {
    const initial: AdvisorSlot[] = [
      { name: "a", description: "First", prompt: "Role a", model: MODEL },
      { name: "b", description: "Second", prompt: "Role b", model: MODEL, variant: "low" },
      { name: "c", description: "Third", prompt: "Role c", model: MODEL },
    ]
    const view = mount({ experimental: { advisors: initial } })
    await settle()
    assert.deepEqual(names(view), ["a", "b", "c"])
    assert.equal(button(view.root, "Add advisor"), undefined, "add button is hidden with three slots")
    assert.equal(view.writes.length, 0, "rendering saved slots does not write")
    assert.equal(button(slot(view, 0), "Move advisor up"), undefined, "the first slot cannot move up")

    await type(slot(view, 2), "Name", "a")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["a", "b"],
      "a duplicate name is kept out of the written array",
    )
    assert.equal(
      field(slot(view, 2), "Name").wrapper.querySelector('[data-slot="input-error"]')?.textContent,
      "Another advisor already uses this name.",
    )

    const count = view.writes.length
    await type(slot(view, 2), "Name", "Bad Name!")
    assert.equal((field(slot(view, 2), "Name").input as HTMLInputElement).value, "bad-name!", "names are slugged")
    assert.equal(view.writes.length, count, "an invalid name does not produce a new write")
    assert.ok(
      field(slot(view, 2), "Name")
        .wrapper.querySelector('[data-slot="input-error"]')
        ?.textContent?.includes("lowercase"),
      "an invalid name shows the format hint",
    )

    await type(slot(view, 2), "Name", "c2")
    assert.deepEqual(written(view), [
      { name: "a", description: "First", prompt: "Role a", model: MODEL },
      { name: "b", description: "Second", prompt: "Role b", model: MODEL, variant: "low" },
      { name: "c2", description: "Third", prompt: "Role c", model: MODEL },
    ])

    await click(slot(view, 1), "Move advisor up")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["b", "a", "c2"],
      "move up reorders the written array",
    )
    assert.deepEqual(names(view), ["b", "a", "c2"])
    assert.ok(slot(view, 0).textContent?.includes("Default"), "the moved slot becomes the default")

    await click(slot(view, 0), "Remove advisor")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["a", "c2"],
      "delete removes the slot from the written array",
    )
    assert.ok(button(view.root, "Add advisor"), "add button returns below the limit")

    // The role prompt is written on blur, not on every keystroke. The new default may clear it again.
    assert.equal(help(slot(view, 0), "Role prompt (optional)"), undefined, "a saved role hides built-in help")
    await type(slot(view, 0), "Role prompt (optional)", "")
    await blur(slot(view, 0), "Role prompt (optional)")
    assert.deepEqual(
      written(view)?.[0],
      { name: "a", description: "First", model: MODEL },
      "the default advisor is saved without a role prompt",
    )
    assert.equal(help(slot(view, 0), "Role prompt (optional)"), BUILTIN_ROLE_HELP)
    const typed = view.writes.length
    await type(slot(view, 0), "Role prompt (optional)", "Look for missing tests.")
    assert.equal(help(slot(view, 0), "Role prompt (optional)"), undefined, "custom role hides built-in help")
    assert.equal(view.writes.length, typed, "typing in the role prompt does not write")
    await blur(slot(view, 0), "Role prompt (optional)")
    assert.deepEqual(written(view)?.[0], {
      name: "a",
      description: "First",
      prompt: "Look for missing tests.",
      model: MODEL,
    })
    await type(slot(view, 0), "Role prompt (optional)", "")
    assert.equal(
      help(slot(view, 0), "Role prompt (optional)"),
      BUILTIN_ROLE_HELP,
      "clearing the role restores built-in help",
    )
    await type(slot(view, 0), "Role prompt (optional)", "   ")
    assert.equal(help(slot(view, 0), "Role prompt (optional)"), BUILTIN_ROLE_HELP, "whitespace keeps built-in help")

    // An external change (for example Discard) reloads the slots.
    view.setConfig({ experimental: { advisors: initial } })
    await settle()
    assert.deepEqual(names(view), ["a", "b", "c"], "slots reload when config changes outside the section")

    // Deleting every slot disables the advisor.
    await click(slot(view, 0), "Remove advisor")
    await click(slot(view, 0), "Remove advisor")
    await click(slot(view, 0), "Remove advisor")
    assert.equal(slots(view).length, 0)
    assert.deepEqual(view.writes.at(-1), DISABLED, "deleting the last slot writes the disable payload")
    assertLegacyNulled(view)
    view.dispose()
  }

  // No config: enabling shows one draft slot; disabling again writes nothing.
  {
    const view = mount({})
    await settle()
    assert.equal(slots(view).length, 0)
    await toggle(view)
    assert.equal(slots(view).length, 1, "enabling shows one empty slot")
    assert.deepEqual(names(view), ["advisor"], "the first enabled advisor uses the default name")
    assert.equal(role(slot(view, 0)), "Role: Standard engineering advisor")
    assert.equal(button(slot(view, 0), "Customize")?.getAttribute("aria-expanded"), "false")
    await customize(slot(view, 0))
    assert.ok(field(slot(view, 0), "Description (optional)"), "description is explicitly optional")
    await type(slot(view, 0), "Description (optional)", "Local metadata")
    await type(slot(view, 0), "Role prompt (optional)", "Local role")
    await customize(slot(view, 0))
    assert.equal(view.writes.length, 0, "opening and closing a model-less draft does not write config")
    await customize(slot(view, 0))
    assert.equal(field(slot(view, 0), "Description (optional)").input.value, "Local metadata")
    assert.equal(field(slot(view, 0), "Role prompt (optional)").input.value, "Local role")
    assert.equal(help(slot(view, 0), "Role prompt (optional)"), undefined, "custom role hides built-in help")
    assert.equal(view.writes.length, 0, "an empty draft slot is not written")
    await click(view.root, "Add advisor")
    assert.deepEqual(names(view), ["advisor", "New advisor"], "later added advisor drafts show a new-advisor header")
    assert.equal(view.writes.length, 0, "later empty draft slots are not written")
    assert.equal((field(slot(view, 1), "Name").input as HTMLInputElement).getAttribute("aria-invalid"), "true")
    await customize(slot(view, 1))
    assert.equal(button(slot(view, 1), "Customize")?.getAttribute("aria-expanded"), "true")
    assert.equal(help(slot(view, 1), "Role prompt"), undefined, "a later advisor has no built-in role to fall back on")
    assert.equal(
      field(slot(view, 1), "Description").wrapper.querySelector('[data-slot="input-error"]')?.textContent,
      "Enter a description so the main agent knows when to consult this advisor.",
      "a later advisor requires a description",
    )
    assert.equal(
      field(slot(view, 1), "Role prompt").wrapper.querySelector('[data-slot="input-error"]')?.textContent,
      "Enter a role prompt to define what this advisor does.",
      "a later advisor requires a role prompt",
    )
    assert.equal(
      field(slot(view, 0), "Role prompt (optional)").wrapper.querySelector('[data-slot="input-error"]'),
      null,
      "the standard first advisor keeps its role prompt optional",
    )
    await toggle(view)
    assert.equal(slots(view).length, 0)
    assert.equal(view.writes.length, 0, "disabling an unsaved draft writes nothing")
    view.dispose()
  }

  // Saved metadata opens customization, while a blank role still reports the standard role.
  {
    const view = mount({
      experimental: {
        advisors: [
          { name: "custom", description: "A custom description", model: MODEL },
          { name: "described", prompt: "A custom role", model: MODEL },
        ],
      },
    })
    await settle()
    assert.equal(button(slot(view, 0), "Customize")?.getAttribute("aria-expanded"), "true")
    assert.equal(button(slot(view, 1), "Customize")?.getAttribute("aria-expanded"), "true")
    assert.equal(role(slot(view, 0)), "Role: Standard engineering advisor")
    assert.equal(role(slot(view, 1)), "Role: Custom")
    assert.equal(field(slot(view, 0), "Description (optional)").input.value, "A custom description")
    assert.equal(field(slot(view, 1), "Role prompt").input.value, "A custom role")
    assert.equal(view.writes.length, 0, "auto-opening saved metadata does not write config")
    view.dispose()
  }

  // A later slot saved without a description or role is incomplete: it stays open and cannot take the default's place.
  {
    const view = mount({
      experimental: {
        advisors: [
          { name: "a", model: MODEL },
          { name: "b", model: MODEL },
        ],
      },
    })
    await settle()
    assert.equal(
      button(slot(view, 0), "Customize")?.getAttribute("aria-expanded"),
      "false",
      "the default stays compact",
    )
    assert.equal(button(slot(view, 1), "Customize")?.getAttribute("aria-expanded"), "true", "the incomplete slot opens")
    await customize(slot(view, 1))
    assert.equal(button(slot(view, 1), "Customize")?.getAttribute("aria-expanded"), "true", "it cannot be collapsed")
    assert.equal(role(slot(view, 1)), "Role: Not set")
    assert.equal(view.writes.length, 0, "rendering an incomplete slot does not write config")

    // The incomplete default would drop out of the config if it moved down, so moving up is locked.
    const up = button(slot(view, 1), "Move advisor up")
    assert(up, "the later slot offers to move up")
    assert.equal(up.hasAttribute("disabled"), true, "moving up is disabled while the default is incomplete")
    assert.equal(
      up.getAttribute("title"),
      "Add a description and role prompt to the default advisor before moving it down.",
    )
    up.click()
    await settle()
    assert.deepEqual(names(view), ["a", "b"], "a locked move does nothing")

    // Typing one required field is not enough: the slot is saved only once both are filled.
    await type(slot(view, 1), "Name", "b2")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["a"],
      "an incomplete later slot is kept out of the written array",
    )
    await type(slot(view, 1), "Description", "Reviews the tests")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["a"],
      "a description alone does not save a later slot",
    )
    assert.equal(
      field(slot(view, 1), "Description").wrapper.querySelector('[data-slot="input-error"]'),
      null,
      "the description error clears once it is filled",
    )
    await type(slot(view, 1), "Role prompt", "   ")
    await blur(slot(view, 1), "Role prompt")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["a"],
      "a whitespace role prompt does not count",
    )
    await type(slot(view, 1), "Role prompt", "Check the tests")
    await blur(slot(view, 1), "Role prompt")
    assert.deepEqual(written(view), [
      { name: "a", model: MODEL },
      { name: "b2", description: "Reviews the tests", prompt: "Check the tests", model: MODEL },
    ])
    assert.equal(role(slot(view, 1)), "Role: Custom")

    // The default is still incomplete, so the move stays locked; filling it unlocks the move.
    assert.equal(button(slot(view, 1), "Move advisor up")?.hasAttribute("disabled"), true)
    await customize(slot(view, 0))
    await type(slot(view, 0), "Description (optional)", "The standard advisor")
    await type(slot(view, 0), "Role prompt (optional)", "Standard role")
    await blur(slot(view, 0), "Role prompt (optional)")
    assert.equal(button(slot(view, 1), "Move advisor up")?.hasAttribute("disabled"), false)
    await click(slot(view, 1), "Move advisor up")
    assert.deepEqual(
      written(view)?.map((item) => item.name),
      ["b2", "a"],
      "a complete default can move down",
    )
    view.dispose()
  }

  // A model-less draft above a saved slot cannot take its name and evict it.
  {
    const view = mount({
      experimental: { advisors: [{ name: "critic", description: "Finds bugs", prompt: "Be critical", model: MODEL }] },
    })
    await settle()
    await click(view.root, "Add advisor")
    await click(slot(view, 1), "Move advisor up")
    await customize(slot(view, 0))
    await type(slot(view, 0), "Name", "critic")
    assert.deepEqual(names(view), ["critic", "critic"])
    assert.equal(view.writes.length, 0, "the saved slot stays written")
    assert.equal(
      field(slot(view, 0), "Name").wrapper.querySelector('[data-slot="input-error"]')?.textContent,
      "Another advisor already uses this name.",
      "the draft shows the duplicate hint",
    )
    await customize(slot(view, 0))
    assert.equal(button(slot(view, 0), "Customize")?.getAttribute("aria-expanded"), "true")
    assert.equal(
      field(slot(view, 1), "Name").wrapper.querySelector('[data-slot="input-error"]'),
      null,
      "the saved slot keeps its name",
    )
    view.dispose()
  }

  // The real ConfigProvider must discard model-less local rows even when the saved advisor JSON is unchanged.
  {
    const saved: Config = {
      hide_prompt_training_models: false,
      snapshot: true,
      experimental: { advisors: [{ name: "a", description: "Saved", model: MODEL, variant: "high" }] },
    }
    const view = mountReal()
    message("configLoaded", saved)
    await settle()
    outbound.length = 0
    assert.deepEqual(state(view).config, saved, "the real provider loads the saved config")
    assert.deepEqual(names(view), ["a"])

    await click(view.root, "Add advisor")
    await type(slot(view, 1), "Name", "draft")
    await type(slot(view, 1), "Description", "Unsaved description")
    await type(slot(view, 1), "Role prompt", "Unsaved role")
    await blur(slot(view, 1), "Role prompt")
    await changeUnrelated(view)
    assert.equal(state(view).dirty, true, "the unrelated setting opens the real save bar")

    await click(view.root, "Discard")
    await settle()
    assert.deepEqual(state(view).config, saved, "discard restores the original provider config")
    assert.deepEqual(names(view), ["a"], "discard removes the unsaved advisor row")
    assert.equal(state(view).dirty, false, "discard clears the real provider draft")
    assert.equal(sent("updateConfig").length, 0, "discard leaves no pending config write")
    view.dispose()
  }

  // A confirmed save and an unchanged server push must not reset a legitimate model-less draft row.
  {
    const saved: Config = {
      hide_prompt_training_models: false,
      experimental: { advisors: [{ name: "a", model: MODEL }] },
    }
    const server = { ...saved, hide_prompt_training_models: true }
    const view = mountReal()
    message("configLoaded", saved)
    await settle()
    await click(view.root, "Add advisor")
    await type(slot(view, 1), "Name", "draft")
    await type(slot(view, 1), "Description", "Kept after save")
    await type(slot(view, 1), "Role prompt", "Keep this role")
    await blur(slot(view, 1), "Role prompt")
    await changeUnrelated(view)

    outbound.length = 0
    await click(view.root, "Save")
    await settle()
    assert.equal(sent("updateConfig").length, 1, "the real Settings Save button sends one update")
    message("configUpdated", server)
    await settle()
    assert.equal(state(view).dirty, false, "the real provider confirms the save")
    assert.deepEqual(names(view), ["a", "draft"], "a confirmed save keeps the model-less draft row")
    assert.equal(field(slot(view, 1), "Description").input.value, "Kept after save")
    assert.equal(field(slot(view, 1), "Role prompt").input.value, "Keep this role")

    message("configLoaded", server)
    await settle()
    assert.deepEqual(names(view), ["a", "draft"], "an unchanged configLoaded push keeps the draft row")
    assert.equal(field(slot(view, 1), "Description").input.value, "Kept after save")
    view.dispose()
  }

  // A first real draft needs only a model and emits no synthesized metadata.
  {
    const view = mountReal()
    message("configLoaded", { hide_prompt_training_models: false, snapshot: true })
    await settle()
    outbound.length = 0
    await toggle(view)
    assert.deepEqual(names(view), ["advisor"])
    assert.equal(sent("updateConfig").length, 0, "enabling a real draft does not write config")
    assert(button(slot(view, 0), "Customize"), "a default advisor starts as a compact card")
    assert.equal(role(slot(view, 0)), "Role: Standard engineering advisor")
    assert(
      [...slot(view, 0).querySelectorAll<HTMLButtonElement>("button")].some((entry) =>
        entry.getAttribute("aria-label")?.startsWith("Advisor Model:"),
      ),
      "the model selector stays accessible in the compact card",
    )

    await chooseModel(slot(view, 0))
    assert.deepEqual(state(view).config.experimental?.advisors, [{ name: "advisor", model: MODEL }])
    assert.equal(state(view).config.experimental?.advisors?.[0]?.description, undefined)
    assert.equal(state(view).config.experimental?.advisors?.[0]?.prompt, undefined)

    outbound.length = 0
    await click(view.root, "Save")
    const update = sent("updateConfig").at(-1)
    assert(update, "the real Settings Save button sends the model-only advisor overlay")
    const payload = update as { config: Config }
    assert.deepEqual(payload.config.experimental?.advisors, [{ name: "advisor", model: MODEL }])
    view.dispose()
  }

  // A focused role edit must blur into the real provider before disclosure closes and Save serializes it.
  {
    const view = mountReal()
    message("configLoaded", { experimental: { advisors: [{ name: "saved", model: MODEL }] } })
    await settle()
    outbound.length = 0
    await customize(slot(view, 0))
    await customize(slot(view, 0))
    assert.equal(state(view).dirty, false, "disclosure-only changes do not dirty the real provider")
    assert.equal(sent("updateConfig").length, 0, "disclosure-only changes send no config update")
    await customize(slot(view, 0))
    await type(slot(view, 0), "Role prompt (optional)", "Latest role text")
    outbound.length = 0
    await customize(slot(view, 0))
    assert.equal(sent("updateConfig").length, 0, "closing customization does not send a config update")
    await click(view.root, "Save")
    await settle()
    const update = sent("updateConfig").at(-1)
    assert(update, "Save sends the pending role edit")
    const payload = update as { config: Config }
    assert.equal(payload.config.experimental?.advisors?.[0]?.prompt, "Latest role text")
    view.dispose()
  }

  // Model selection, metadata, variants, and legacy-key removal must use the real provider and picker.
  {
    const savedPrompt = "Preserve this saved advisor role exactly."
    const saved: Config = {
      experimental: {
        advisors: [{ name: "saved", description: "Keep", prompt: savedPrompt, model: MODEL, variant: "low" }],
        advisor_model: "kilo/legacy-model",
        advisor_variant: "low",
      },
    }
    const view = mountReal()
    message("configLoaded", saved)
    await settle()
    await click(view.root, "Add advisor")
    await type(slot(view, 1), "Name", "reviewer")
    await chooseModel(slot(view, 1))
    assert.equal(
      state(view).config.experimental?.advisors?.length,
      1,
      "a named later advisor with a model is not saved without a description and role prompt",
    )
    await type(slot(view, 1), "Description", "Checks the change")
    assert.equal(state(view).config.experimental?.advisors?.length, 1, "a description alone does not save it")
    await type(slot(view, 1), "Role prompt", "Review the proposed change")
    await blur(slot(view, 1), "Role prompt")
    assert.equal(state(view).config.experimental?.advisors?.length, 2, "the description and role prompt save it")
    await chooseVariant(slot(view, 1))

    const local = state(view).config.experimental
    assert.deepEqual(local?.advisors, [
      { name: "saved", description: "Keep", prompt: savedPrompt, model: MODEL, variant: "low" },
      {
        name: "reviewer",
        description: "Checks the change",
        prompt: "Review the proposed change",
        model: MODEL,
        variant: "high",
      },
    ])
    assert.equal(local?.advisor_model, undefined, "the local config drops the legacy advisor model")
    assert.equal(local?.advisor_variant, undefined, "the local config drops the legacy advisor variant")

    outbound.length = 0
    await click(view.root, "Save")
    await settle()
    const update = sent("updateConfig").at(-1)
    assert(update, "the real Settings Save button sends the advisor overlay")
    const payload = update as {
      config: Config
      globalUnset?: string[][]
      projectUnset?: string[][]
    }
    assert.deepEqual(payload.config.experimental?.advisors, local?.advisors, "the saved slot is not evicted")
    assert.equal(
      payload.config.experimental?.advisors?.[0]?.prompt,
      savedPrompt,
      "the overlay preserves the saved prompt",
    )
    assert.equal(payload.config.experimental?.advisor_model, undefined)
    assert.equal(payload.config.experimental?.advisor_variant, undefined)
    const unset = [...(payload.globalUnset ?? []), ...(payload.projectUnset ?? [])]
    assert.ok(unset.some((path) => path.join(".") === "experimental.advisor_model"))
    assert.ok(unset.some((path) => path.join(".") === "experimental.advisor_variant"))
    view.dispose()
  }

  assert.deepEqual(errors, [])
} finally {
  await window.happyDOM.close()
}
