/**
 * Config context
 * Manages backend configuration state (permissions, agents, providers, etc.)
 * and exposes an updateConfig method to apply partial updates.
 *
 * Changes are accumulated in a local draft and only sent to the extension
 * when saveConfig() is called. This allows batching multiple settings
 * changes into a single write (which triggers disposeAll on the CLI).
 */

import { createContext, useContext, createSignal, createMemo, onCleanup } from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { useVSCode } from "./vscode"
import type {
  Config,
  ConfigCollections,
  // fork_change start
  ConfigLoadedMessage,
  ConfigUpdatedMessage,
  // fork_change end
  ExtensionMessage,
  FeatureFlags,
  SettingsConfigBinding,
} from "../types/messages"
import {
  configUnsetPaths,
  // fork_change start
  acceptsConfig,
  // fork_change end
  deepMerge,
  mergeScopedConfig,
  pruneConfigSet,
  stripNulls,
  resolveConfig,
} from "../utils/config-utils"
import { splitConfigByScope } from "../utils/config-scope"

function has(value: Record<string, unknown>) {
  return Object.keys(value).length > 0
}

export interface SaveError {
  message: string
  details?: string
}

interface ConfigContextValue {
  config: Accessor<Config>
  globalConfig: Accessor<Config>
  globalDraft: Accessor<Partial<Config>>
  // fork_change start
  globalEffectiveConfig: Accessor<Config>
  // fork_change end
  projectConfig: Accessor<Config>
  // fork_change start
  projectBinding: Accessor<SettingsConfigBinding | undefined>
  // fork_change end
  collections: Accessor<ConfigCollections>
  settings: Accessor<Record<string, unknown>>
  features: Accessor<FeatureFlags>
  loading: Accessor<boolean>
  isDirty: Accessor<boolean>
  saving: Accessor<boolean>
  // fork_change start
  blocked: Accessor<boolean>
  // fork_change end
  saveError: Accessor<SaveError | null>
  updateConfig: (partial: Partial<Config>) => void
  updateGlobalConfig: (partial: Partial<Config>) => void
  updateProjectConfig: (partial: Partial<Config>) => void
  updateSetting: (key: string, value: unknown) => void
  applySetting: (key: string, value: unknown, writeKey?: string) => void
  saveConfig: () => void
  discardConfig: () => void
}

export const ConfigContext = createContext<ConfigContextValue>()

function loadedSettings(message: ExtensionMessage): Record<string, unknown> | undefined {
  if (message.type === "autocompleteSettingsLoaded") {
    return {
      "autocomplete.enableAutoTrigger": message.settings.enableAutoTrigger,
      "autocomplete.enableSmartInlineTaskKeybinding": message.settings.enableSmartInlineTaskKeybinding,
      "autocomplete.enableChatAutocomplete": message.settings.enableChatAutocomplete,
      "autocomplete.provider": message.settings.provider,
      "autocomplete.model": message.settings.model,
    }
  }
  if (message.type === "indexingSettingsLoaded") {
    return { "indexing.showButtonWhenDisabled": message.settings.showButtonWhenDisabled }
  }
  if (message.type === "chatSettingsLoaded") {
    return { "chat.shiftTabCyclesVariant": message.settings.shiftTabCyclesVariant }
  }
  if (message.type === "throughputSettingLoaded") return { showTokenThroughput: message.visible }
  if (message.type === "autoApprovalReasonSettingLoaded") return { showAutoApprovalReason: message.visible }
}

// fork_change start
type ConfigMessage = ConfigLoadedMessage | ConfigUpdatedMessage

// fork_change end
export const ConfigProvider: ParentComponent = (props) => {
  const vscode = useVSCode()

  const [config, setConfig] = createSignal<Config>({})
  const [globalConfig, setGlobalConfig] = createSignal<Config>({})
  // fork_change start
  const [globalEffectiveConfig, setGlobalEffectiveConfig] = createSignal<Config>({})
  // fork_change end
  const [projectConfig, setProjectConfig] = createSignal<Config>({})
  const [collections, setCollections] = createSignal<ConfigCollections>({})
  const [settings, setSettings] = createSignal<Record<string, unknown>>({})
  const [features, setFeatures] = createSignal<FeatureFlags>({
    indexing: false,
    sandboxControls: false,
    backgroundSubagents: false,
  })
  const [loading, setLoading] = createSignal(true)
  const [draft, setDraft] = createSignal<Partial<Config>>({})
  const [globalDraft, setGlobalDraft] = createSignal<Partial<Config>>({})
  const [projectDraft, setProjectDraft] = createSignal<Partial<Config>>({})
  const [settingsDraft, setSettingsDraft] = createSignal<Record<string, unknown>>({})
  const [bindings, setBindings] = createSignal<{ global?: SettingsConfigBinding; project?: SettingsConfigBinding }>({})
  const isDirty = createMemo(
    () =>
      has(draft() as Record<string, unknown>) ||
      has(globalDraft() as Record<string, unknown>) ||
      has(projectDraft() as Record<string, unknown>) ||
      has(settingsDraft()),
  )
  // Last config received from the server — used to revert on discard
  const [saved, setSaved] = createSignal<Config>({})
  const [savedGlobal, setSavedGlobal] = createSignal<Config>({})
  const [savedProject, setSavedProject] = createSignal<Config>({})
  const [savedSettings, setSavedSettings] = createSignal<Record<string, unknown>>({})
  // True while a saveConfig() write is in-flight — used to clear draft on success
  // and to guard against stale configLoaded messages overwriting optimistic state.
  const [saving, setSaving] = createSignal(false)
  // fork_change start
  const [blocked, setBlocked] = createSignal(false)
  // fork_change end
  // Error from the most recent saveConfig() attempt, or null if no error.
  // Cleared when the user edits the draft again or starts a new save.
  const [saveError, setSaveError] = createSignal<SaveError | null>(null)
  const updateCollections = (next: ConfigCollections | undefined) => {
    if (next !== undefined) setCollections(next)
  }

  // fork_change start
  const updateGlobal = (message: ConfigMessage, merge: boolean) => {
    if (message.globalConfig !== undefined) {
      setGlobalConfig(merge ? mergeScopedConfig(message.globalConfig, globalDraft()) : message.globalConfig)
      setSavedGlobal(message.globalConfig)
    }
    if (message.globalEffectiveConfig !== undefined) setGlobalEffectiveConfig(message.globalEffectiveConfig)
  }

  const updateProject = (message: ConfigMessage, merge: boolean) => {
    if (message.projectConfig === undefined) return
    setProjectConfig(merge ? mergeScopedConfig(message.projectConfig, projectDraft()) : message.projectConfig)
    setSavedProject(message.projectConfig)
  }

  const updateState = (message: ConfigMessage) => {
    updateCollections(message.collections)
    setFeatures(message.features)
    setBindings(message.bindings ?? bindings())
  }

  const load = (message: ConfigLoadedMessage) => {
    if (!acceptsConfig(saving(), blocked())) return
    // Re-apply the draft on top so pending changes stay visible instead of snapping back.
    setConfig(resolveConfig(message.config, draft(), has(draft() as Record<string, unknown>)))
    setSaved(message.config)
    if (message.settings) mergeSettings(message.settings)
    updateGlobal(message, true)
    updateProject(message, true)
    updateState(message)
    setLoading(false)
  }

  const confirm = (message: ConfigUpdatedMessage) => {
    setSaving(false)
    setDraft({})
    setGlobalDraft({})
    setProjectDraft({})
    setSaveError(null)
    setConfig(message.config)
    updateGlobal(message, true)
    updateProject(message, false)
    updateState(message)
  }

  const update = (message: ConfigUpdatedMessage) => {
    if (blocked() && !saving()) return
    if (saving()) {
      confirm(message)
    } else {
      // Re-apply the draft on top so pending settings changes are preserved.
      setConfig(resolveConfig(message.config, draft(), has(draft() as Record<string, unknown>)))
      updateGlobal(message, true)
      updateProject(message, true)
      updateState(message)
    }
    if (message.settings) mergeSettings(message.settings)
    setSaved(message.config)
  }

  // fork_change end
  // Register handler immediately (not in onMount) so we never miss
  // a configLoaded message that arrives before the DOM mount.
  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    const patch = loadedSettings(message)
    if (patch) return mergeSettings(patch)
    // fork_change start
    if (message.type === "configLoaded") {
      load(message)
      return
    }
    if (message.type === "globalConfigLoaded") {
      if (!acceptsConfig(saving(), blocked())) return
      setGlobalConfig(mergeScopedConfig(message.config, globalDraft()))
      setSavedGlobal(message.config)
      return
    }
    if (message.type === "configUpdated") {
      update(message)
      return
    }
    // fork_change end
  })
  const unsubscribeExpired = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "configBindingExpired") return
    setBindings({})
    if (isDirty()) {
      // fork_change start
      setBlocked(true)
      // fork_change end
      setSaveError({ message: "The Settings project changed. Discard or reload before saving." })
      return
    }
    vscode.postMessage({ type: "requestConfig" })
  })
  const unsubscribeFailure = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "configUpdateFailed") return
    setSaving(false)
    if (message.completedScopes?.length) {
      const split = splitConfigByScope(draft())
      const remaining = message.completedScopes.includes("global")
        ? split.project
        : message.completedScopes.includes("project")
          ? split.global
          : draft()
      setDraft(message.completedScopes.length === 2 ? {} : remaining)
    }
    if (message.completedScopes?.includes("global")) {
      setGlobalDraft({})
      if (message.globalConfig) {
        setGlobalConfig(message.globalConfig)
        setSavedGlobal(message.globalConfig)
      }
    }
    if (message.completedScopes?.includes("project")) {
      setProjectDraft({})
      if (message.projectConfig) {
        setProjectConfig(message.projectConfig)
        setSavedProject(message.projectConfig)
      }
    }
    if (message.config) {
      setConfig(resolveConfig(message.config, draft(), has(draft() as Record<string, unknown>)))
      setSaved(message.config)
    }
    if (message.bindings) setBindings(message.bindings)
    // fork_change start
    if (message.globalEffectiveConfig !== undefined) setGlobalEffectiveConfig(message.globalEffectiveConfig)
    // fork_change end
    setSaveError({ message: message.message, details: message.details })
  })
  const unsubscribeIndexing = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "indexingSettingsLoaded") return
    mergeSettings({
      "indexing.showButtonWhenDisabled": message.settings.showButtonWhenDisabled,
      "indexing.consent": message.settings.consent,
      "indexing.projects": message.settings.projects,
      "indexing.projectId": message.settings.projectId,
    })
  })
  const unsubscribeChat = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "chatSettingsLoaded") return
    mergeSettings({
      "chat.shiftTabCyclesVariant": message.settings.shiftTabCyclesVariant,
    })
  })

  onCleanup(() => {
    unsubscribe()
    unsubscribeExpired()
    unsubscribeFailure()
    unsubscribeIndexing()
    unsubscribeChat()
  })

  function mergeSettings(patch: Record<string, unknown>) {
    setSavedSettings((prev) => ({ ...prev, ...patch }))
    setSettings((prev) => ({ ...prev, ...patch, ...settingsDraft() }))
  }

  const requestInitialData = () => {
    vscode.postMessage({ type: "requestConfig" })
    vscode.postMessage({ type: "requestAutocompleteSettings" })
    vscode.postMessage({ type: "requestIndexingSettings" })
    vscode.postMessage({ type: "requestChatSettings" })
  }

  // Request config immediately; if the extension's httpClient is not yet ready,
  // extensionDataReady will fire once initialization completes and we retry once.
  requestInitialData()

  const fallback = setTimeout(() => {
    if (loading()) {
      requestInitialData()
    }
  }, 3000)

  const unsubReady = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "extensionDataReady") return
    unsubReady()
    clearTimeout(fallback)
    if (loading()) {
      requestInitialData()
    }
  })

  onCleanup(() => {
    unsubReady()
    clearTimeout(fallback)
  })

  function updateConfig(partial: Partial<Config>) {
    // fork_change start
    if (blocked()) return
    // fork_change end
    // Optimistically update local state with deep merge + null stripping
    setConfig((prev) => stripNulls(deepMerge(prev, partial)))
    // Accumulate in draft — will be sent on saveConfig()
    setDraft((prev) => deepMerge(prev as Config, partial))
    // Clear any stale error from a previous failed save — the user is editing
    // again, so the old error message no longer reflects the current draft.
    setSaveError(null)
  }

  function updateGlobalConfig(partial: Partial<Config>) {
    // fork_change start
    if (blocked()) return
    // fork_change end
    setGlobalConfig((prev) => mergeScopedConfig(prev, partial))
    setGlobalDraft((prev) => deepMerge(prev as Config, partial))
    setSaveError(null)
  }

  function updateProjectConfig(partial: Partial<Config>) {
    // fork_change start
    if (blocked()) return
    // fork_change end
    setProjectConfig((prev) => mergeScopedConfig(prev, partial))
    setProjectDraft((prev) => deepMerge(prev as Config, partial))
    setSaveError(null)
  }

  function updateSetting(key: string, value: unknown) {
    // fork_change start
    if (blocked()) return
    // fork_change end
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSettingsDraft((prev) => ({ ...prev, [key]: value }))
    setSaveError(null)
  }

  /**
   * Write a VS Code setting immediately, bypassing the save-bar draft.
   * For app-level feature gates whose effect lives outside the settings page,
   * where staging the change would make the control feel unresponsive.
   * `key` is the local settings() property; `writeKey` is the VS Code
   * configuration key when the two differ (e.g. namespaced experimental keys).
   */
  function applySetting(key: string, value: unknown, writeKey?: string) {
    setSavedSettings((prev) => ({ ...prev, [key]: value }))
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSettingsDraft((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    setSaveError(null)
    vscode.postMessage({ type: "updateSetting", key: writeKey ?? key, value })
  }

  function saveConfig() {
    // fork_change start
    if (blocked()) return
    // fork_change end
    const changes = draft()
    const globals = globalDraft()
    const projects = projectDraft()
    const pending = settingsDraft()
    const configDirty = has(changes as Record<string, unknown>)
    const globalDirty = has(globals as Record<string, unknown>)
    const projectDirty = has(projects as Record<string, unknown>)
    const settingsDirty = has(pending)
    if (!configDirty && !globalDirty && !projectDirty && !settingsDirty) return
    // Don't clear draft/isDirty yet — wait for configUpdated confirmation.
    // If the write fails, the save bar stays visible so the user can retry.
    setSaving(true)
    setSaveError(null)
    if (settingsDirty) {
      for (const [key, value] of Object.entries(pending)) {
        vscode.postMessage({ type: "updateSetting", key, value })
      }
      setSavedSettings((prev) => ({ ...prev, ...pending }))
      setSettingsDraft({})
    }
    if (!configDirty && !globalDirty && !projectDirty) {
      setSaving(false)
      return
    }
    // Split so per-project settings (e.g. commit_message.prompt) land in the
    // workspace's kilo.json instead of the global one. Send one message so the
    // extension confirms only after both scopes are saved.
    const split = splitConfigByScope(changes)
    const next = deepMerge(split.global as Config, globals)
    const project = deepMerge(split.project as Config, projects)
    vscode.postMessage({
      type: "updateConfig",
      config: pruneConfigSet(next) as Config,
      projectConfig: pruneConfigSet(project) as Config,
      globalUnset: configUnsetPaths(next),
      projectUnset: configUnsetPaths(project),
      globalBindingId: bindings().global?.id,
      projectBindingId: bindings().project?.id,
    })
  }

  function discardConfig() {
    // fork_change start
    const reload = blocked()
    // fork_change end
    setConfig(saved())
    setGlobalConfig(savedGlobal())
    setProjectConfig(savedProject())
    setDraft({})
    setGlobalDraft({})
    setProjectDraft({})
    setSettings(savedSettings())
    setSettingsDraft({})
    // fork_change start
    setBlocked(false)
    // fork_change end
    setSaveError(null)
    // fork_change start
    if (reload) {
      setLoading(true)
      vscode.postMessage({ type: "requestConfig" })
    }
    // fork_change end
  }

  const value: ConfigContextValue = {
    config,
    globalConfig,
    globalDraft,
    // fork_change start
    globalEffectiveConfig,
    // fork_change end
    projectConfig,
    // fork_change start
    projectBinding: () => bindings().project,
    // fork_change end
    collections,
    settings,
    features,
    loading,
    isDirty,
    saving,
    // fork_change start
    blocked,
    // fork_change end
    saveError,
    updateConfig,
    updateGlobalConfig,
    updateProjectConfig,
    updateSetting,
    applySetting,
    saveConfig,
    discardConfig,
  }

  return <ConfigContext.Provider value={value}>{props.children}</ConfigContext.Provider>
}

export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider")
  }
  return context
}
