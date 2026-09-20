import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ConfigState } from "../../webview-ui/src/utils/config-utils"

const FILE = path.resolve(import.meta.dir, "../../webview-ui/src/components/settings/ExperimentalTab.tsx")

describe("SWE-Pruner settings", () => {
  it("stages and discards the experimental toggle without losing the model", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({
      experimental: { swe_pruner: false, swe_pruner_model: "openai/gpt-4o-mini" },
    })

    state.updateConfig({
      experimental: { ...state.config.experimental, swe_pruner: true },
    })

    expect(state.config.experimental?.swe_pruner).toBe(true)
    expect(state.config.experimental?.swe_pruner_model).toBe("openai/gpt-4o-mini")
    expect(state.draft.experimental?.swe_pruner).toBe(true)

    state.discardConfig()

    expect(state.config.experimental?.swe_pruner).toBe(false)
    expect(state.config.experimental?.swe_pruner_model).toBe("openai/gpt-4o-mini")
  })

  it("stores and confirms an exact provider/model identifier", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({ experimental: { swe_pruner: true } })
    state.updateConfig({ experimental: { swe_pruner: true, swe_pruner_model: "openai/openai/gpt-4o-mini" } })

    expect(state.draft.experimental?.swe_pruner_model).toBe("openai/openai/gpt-4o-mini")
    state.saveConfig()
    state.handleConfigUpdated({
      experimental: { swe_pruner: true, swe_pruner_model: "openai/openai/gpt-4o-mini" },
    })

    expect(state.config.experimental?.swe_pruner_model).toBe("openai/openai/gpt-4o-mini")
    expect(state.dirty).toBe(false)
    expect(state.saving).toBe(false)
  })

  it("uses the null sentinel to clear the model override", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({
      experimental: { swe_pruner: true, swe_pruner_model: "anthropic/claude-haiku" },
    })

    state.updateConfig({
      experimental: { swe_pruner: true, swe_pruner_model: null },
    })

    expect(state.config.experimental?.swe_pruner_model).toBeUndefined()
    expect(state.draft.experimental?.swe_pruner_model).toBeNull()
  })

  it("keeps the selector model while the feature is disabled", () => {
    const state = new ConfigState()
    state.handleConfigLoaded({
      experimental: { swe_pruner: true, swe_pruner_model: "google/gemini-flash" },
    })

    state.updateConfig({
      experimental: { ...state.config.experimental, swe_pruner: false },
    })

    expect(state.config.experimental).toEqual({
      swe_pruner: false,
      swe_pruner_model: "google/gemini-flash",
    })
  })

  it("reuses the model selector with an explicit connected-provider catalog", () => {
    const source = fs.readFileSync(FILE, "utf8")

    expect(source).toContain('import { ModelSelectorBase } from "../shared/ModelSelector"')
    expect(source).toContain('import { useProvider } from "../../context/provider"')
    expect(source).toContain("provider.connected()")
    expect(source).toContain("provider.models().filter")
    expect(source).toContain("connected.has(model.providerID)")
    expect(source).toContain("models={pruningModels()}")
    expect(source).toContain("allowClear")
    expect(source).toContain('updateExperimental("swe_pruner_model", null)')
    expect(source).not.toContain("includeAutoSmall")
  })
})
