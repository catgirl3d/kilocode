import { describe, expect, it } from "bun:test"
import { ConfigState } from "../../webview-ui/src/utils/config-utils"

describe("task subagent model selection config", () => {
  it("stages the experimental toggle and discards it", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({ experimental: { task_model_selection: false } })

    state.updateConfig({ experimental: { task_model_selection: true } })

    expect(state.config.experimental?.task_model_selection).toBe(true)
    expect(state.draft.experimental?.task_model_selection).toBe(true)
    expect(state.dirty).toBe(true)

    state.discardConfig()

    expect(state.config.experimental?.task_model_selection).toBe(false)
    expect(state.dirty).toBe(false)
  })

  it("clears the draft after the backend confirms the save", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({ experimental: { task_model_selection: false } })
    state.updateConfig({ experimental: { task_model_selection: true } })
    state.saveConfig()

    expect(state.saving).toBe(true)

    state.handleConfigUpdated({ experimental: { task_model_selection: true } })

    expect(state.config.experimental?.task_model_selection).toBe(true)
    expect(state.dirty).toBe(false)
    expect(state.saving).toBe(false)
    expect(state.draft).toEqual({})
  })

  it("replaces the allowed task model list on every update", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({ experimental: { task_model_selection: true } })

    state.updateConfig({ experimental: { task_models: ["a/one", "b/two"] } })
    expect(state.config.experimental?.task_models).toEqual(["a/one", "b/two"])

    state.updateConfig({ experimental: { task_models: ["a/one"] } })
    expect(state.config.experimental?.task_models).toEqual(["a/one"])

    state.updateConfig({ experimental: { task_models: [] } })
    expect(state.config.experimental?.task_models).toEqual([])
    expect(state.draft.experimental?.task_models).toEqual([])
  })
})
