/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type { Config } from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
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
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  customElements: window.customElements,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  MessageEvent: window.MessageEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { ProviderProvider } = await import("../../webview-ui/src/context/provider")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { Toast } = await import("@kilocode/kilo-ui/toast")
const { LanguageContext } = await import("../../webview-ui/src/context/language")
const { ConfigContext } = await import("../../webview-ui/src/context/config")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { SubagentModelSelector } = await import("../../webview-ui/src/components/chat/SubagentModelSelector")
const { dict } = await import("../../webview-ui/src/i18n/en")
const { post } = await import("../../webview-ui/src/utils/webview-message")

const language = {
  locale: () => "en",
  setLocale: () => {},
  userOverride: () => "",
  t: (key: string) => dict[key as keyof typeof dict] ?? key,
}

const copy = {
  title: dict["settings.providers.subagentModel.title"],
  inherit: dict["settings.providers.subagentModel.inherit"],
  inheritHint: dict["settings.providers.subagentModel.inheritHint"],
  overrides: dict["settings.providers.subagentModel.overrides"],
  choice: dict["settings.providers.subagentModel.agentChoice"],
  failed: dict["settings.providers.subagentModel.updateFailed"],
}
assert.ok(copy.inheritHint && copy.overrides && copy.choice && copy.failed, "the quick selector copy exists")

const providers = {
  kilo: {
    id: "kilo",
    name: "Kilo",
    models: {
      current: { id: "current", name: "Current Model", variants: { high: {}, medium: {}, low: {} } },
      next: { id: "next", name: "Next Model", variants: { medium: {}, low: {} } },
    },
  },
}
const catalog = {
  type: "providersLoaded" as const,
  providers,
  connected: ["kilo"],
  defaults: {},
  ready: true,
  defaultSelection: { providerID: "kilo", modelID: "current" },
  authMethods: {},
  authStates: {},
}

const settle = async () => {
  await Promise.resolve()
  await window.happyDOM.waitUntilComplete()
}

type Options = {
  config?: Partial<Config>
  project?: Partial<Config>
  agents?: { name: string; mode: "primary" | "subagent" | "all" }[]
  blocked?: boolean
  applying?: boolean
  saving?: boolean
  loading?: boolean
  expired?: boolean
  failure?: string
}

type Call = { partial: Partial<Config>; scope: "global" | "project" }

async function mount(options: Options = {}) {
  const calls: Call[] = []
  const focus: Event[] = []
  const value = {
    config: () => (options.config ?? {}) as Config,
    globalConfig: () => (options.config ?? {}) as Config,
    mergedGlobalConfig: () => (options.config ?? {}) as Config,
    homeDir: () => undefined,
    workspaceConfig: () => ({}),
    projectConfig: () => (options.project ?? {}) as Config,
    projectDraft: () => ({}),
    globalDraft: () => ({}),
    globalEffectiveConfig: () => (options.config ?? {}) as Config,
    projectBinding: () => undefined,
    collections: () => ({}),
    settings: () => ({}),
    shortcuts: () => ({ bindings: {}, selection: false }),
    features: () => ({ indexing: false, sandboxControls: false, backgroundSubagents: false, speechToText: false }),
    loading: () => options.loading ?? false,
    isDirty: () => false,
    saving: () => options.saving ?? false,
    applying: () => options.applying ?? false,
    discarded: () => 0,
    blocked: () => options.expired ?? false,
    saveError: () => null,
    clearSaveError: () => {},
    updateConfig: () => {},
    updateGlobalConfig: () => {},
    updateProjectConfig: () => {},
    updateSetting: () => {},
    applyConfig: (partial: Partial<Config>, scope: "global" | "project", fail?: (message?: string) => void) => {
      calls.push({ partial, scope })
      if (options.failure !== undefined) fail?.(options.failure)
    },
    applySetting: () => {},
    saveConfig: () => {},
    discardConfig: () => {},
  }
  const session = {
    allAgents: () => options.agents ?? [],
    favoriteModels: () => [],
    modelUsageHistory: () => ({}),
    toggleFavorite: () => {},
    moveFavorite: () => {},
  }
  const host = document.createElement("div")
  document.body.append(host)
  const listener = (event: Event) => focus.push(event)
  window.addEventListener("focusPrompt", listener as never)
  const dispose = render(
    () => (
      <VSCodeProvider>
        <DialogProvider>
          <ProviderProvider>
            <LanguageContext.Provider value={language as never}>
              <ConfigContext.Provider value={value as never}>
                <SessionContext.Provider value={session as never}>
                  <SubagentModelSelector blocked={options.blocked} />
                  <Toast.Region />
                </SessionContext.Provider>
              </ConfigContext.Provider>
            </LanguageContext.Provider>
          </ProviderProvider>
        </DialogProvider>
      </VSCodeProvider>
    ),
    host,
  )
  await settle()
  post(structuredClone(catalog))
  post({ type: "modelSelectorExpandedLoaded", value: false })
  await settle()
  const button = () => {
    const found = host.querySelector<HTMLButtonElement>("button.subagent-model-selector-quick-open")
    assert.ok(found, "the quick subagent model selector renders its trigger")
    return found
  }
  const description = () => host.querySelector(".model-selector-assistive")?.textContent ?? ""
  const close = () => {
    window.removeEventListener("focusPrompt", listener as never)
    dispose()
    host.remove()
  }
  return { host, calls, focus, button, description, close }
}

async function open(view: Awaited<ReturnType<typeof mount>>) {
  view.button().click()
  await settle()
}

async function press(key: string) {
  const body = document.querySelector<HTMLElement>(".model-selector-body")
  assert.ok(body, "the model list is open")
  body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event)
  await settle()
}

try {
  const initial = await mount()
  assert.equal(initial.button().disabled, false, "an idle quick selector is enabled")
  window.dispatchEvent(new window.CustomEvent("openModelPicker", { detail: {} }))
  await settle()
  assert.equal(
    document.querySelector(".model-selector-body"),
    null,
    "the /models command does not open the subagent model picker",
  )
  assert.ok(initial.button().querySelector("svg"), "the quick selector renders the subagent icon")
  assert.ok(
    initial.description().includes(copy.inheritHint),
    "the quick selector explains that subagents inherit the main model",
  )
  assert.ok(!initial.description().includes(copy.overrides), "an unset model has no override note")
  const trigger = initial.host.querySelector<HTMLElement>('[data-component="tooltip-trigger"]')
  assert.ok(trigger, "the quick selector wraps its trigger in a tooltip")
  trigger.dispatchEvent(new window.PointerEvent("pointerenter", { bubbles: true }) as unknown as Event)
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const tooltip = [...document.querySelectorAll<HTMLElement>('[data-component="tooltip"]')].at(-1)
  assert.ok(tooltip, "hovering the quick selector shows its tooltip")
  assert.equal(
    tooltip.textContent,
    `${copy.title}: ${copy.inherit} ${copy.inheritHint}`,
    "the quick selector tooltip names the current choice and hints",
  )
  initial.close()

  const selected = await mount({ config: { subagent_model: "kilo/current" } })
  const selectedTrigger = selected.host.querySelector<HTMLElement>('[data-component="tooltip-trigger"]')
  assert.ok(selectedTrigger, "the selected model keeps the tooltip trigger")
  selectedTrigger.dispatchEvent(new window.PointerEvent("pointerenter", { bubbles: true }) as unknown as Event)
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const selectedTooltip = [...document.querySelectorAll<HTMLElement>('[data-component="tooltip"]')].at(-1)
  assert.equal(
    selectedTooltip?.textContent,
    `${copy.title}: Current Model`,
    "the quick selector tooltip names the selected model",
  )
  selected.close()

  const filtered = await mount({
    config: { subagent_model: "kilo/current", agent: { build: { model: "kilo/current" }, explore: {} } },
    agents: [
      { name: "build", mode: "primary" },
      { name: "explore", mode: "subagent" },
    ],
  })
  assert.ok(
    !filtered.description().includes(copy.overrides),
    "an agent model only counts for subagents with their own model",
  )
  filtered.close()

  const overrides = await mount({
    config: { subagent_model: "kilo/current", agent: { explore: { model: "kilo/other" } } },
    agents: [{ name: "explore", mode: "subagent" }],
  })
  assert.ok(
    overrides.description().includes(copy.overrides),
    "the quick selector reports subagents with their own model",
  )
  overrides.close()

  const experiment = await mount({
    config: { subagent_model: "kilo/current", experimental: { task_model_selection: true } },
  })
  assert.ok(
    experiment.description().includes(copy.choice),
    "the quick selector explains the experimental per-task model choice",
  )
  experiment.close()

  const project = await mount({
    config: { subagent_model: "kilo/current", subagent_variant: "high" },
    project: { subagent_model: "kilo/current" },
  })
  await open(project)
  await press("ArrowDown")
  await press("Enter")
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const picked = project.calls.at(-1)
  assert.ok(picked, "selecting a model applies a quick config patch")
  assert.deepEqual(
    picked.partial,
    {
      subagent_model: "kilo/next",
      subagent_variant: null,
      subagent_variant_overrides: { "kilo/next": "medium" },
    },
    "the quick selector saves a compatible reasoning effort",
  )
  assert.equal(picked.scope, "project", "a pinned workspace saves the quick choice to the project")
  assert.equal(project.focus.length, 1, "picking a model returns focus to the prompt")
  project.close()

  const global = await mount({ config: { subagent_model: "kilo/current" } })
  await open(global)
  await press("ArrowDown")
  await press("Enter")
  await settle()
  assert.equal(global.calls.at(-1)?.scope, "global", "the quick selector saves globally by default")
  global.close()

  const clear = await mount({ config: { subagent_model: "kilo/current" } })
  await open(clear)
  await press("ArrowUp")
  await press("ArrowUp")
  await press("Enter")
  await settle()
  assert.deepEqual(
    clear.calls.at(-1)?.partial,
    { subagent_model: null, subagent_variant: null },
    "clearing the quick selector unsets the subagent model",
  )
  clear.close()

  const escape = await mount({ config: { subagent_model: "kilo/current" } })
  await open(escape)
  await press("Escape")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(escape.focus.length, 1, "closing the picker returns focus to the prompt")
  escape.close()

  const blocked = await mount({ blocked: true })
  assert.equal(blocked.button().disabled, true, "a blocked prompt disables the quick selector")
  blocked.close()

  const expired = await mount({ expired: true })
  assert.equal(expired.button().disabled, true, "an expired config disables the quick selector")
  expired.close()

  const loading = await mount({ loading: true })
  assert.equal(loading.button().disabled, true, "the quick selector is disabled while the config loads")
  loading.close()

  const applying = await mount({ applying: true })
  assert.equal(applying.button().disabled, true, "the quick selector is disabled while a quick write is in flight")
  applying.close()

  const saving = await mount({ saving: true })
  assert.equal(saving.button().disabled, true, "the quick selector is disabled while Settings are saving")
  saving.close()

  const failure = await mount({ config: { subagent_model: "kilo/current" }, failure: "quick write failed" })
  await open(failure)
  await press("ArrowDown")
  await press("Enter")
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const toast = [...document.querySelectorAll<HTMLElement>('[data-component="toast"][data-variant="error"]')].at(-1)
  assert.ok(toast, "a failed quick write shows an error toast")
  assert.equal(
    toast.querySelector("[data-slot='toast-title']")?.textContent,
    copy.failed,
    "a failed quick write names the failed update",
  )
  assert.equal(
    toast.querySelector("[data-slot='toast-description']")?.textContent,
    "quick write failed",
    "a failed quick write passes the host reason",
  )
  failure.close()

  assert.deepEqual(errors, [])
} finally {
  await window.happyDOM.close()
}
