// fork_change - new file
import { batch } from "solid-js"
import type { ModelSelection } from "../types/messages"
import { DEFAULT_VARIANT, preserveVariant, variantKey } from "./session-variant-store"
import type { createModelSelector } from "./session-model-selector"
import type { createSessionVariants } from "./session-variants"
import type { useProvider } from "./provider"

interface Deps {
  select: ReturnType<typeof createModelSelector>["select"]
  agentForScope: (sessionID?: string) => string
  scope: () => string
  draft: (id: string) => boolean
  variantSelections: () => Record<string, string>
  variantForAgent: ReturnType<typeof createSessionVariants>["agent"]
  findModel: ReturnType<typeof useProvider>["findModel"]
  rememberEffort: (agent: string, model: ModelSelection, value: string) => void
}

export function createSessionModelActions(deps: Deps) {
  function selectModel(providerID: string, modelID: string, sessionID?: string, remember = true) {
    const id = sessionID ?? deps.scope()
    batch(() => {
      deps.select(providerID, modelID, id, remember)
      if (!remember || !deps.draft(id)) return
      const model = { providerID, modelID }
      const agent = deps.agentForScope(id)
      const value = deps.variantSelections()[variantKey(model, agent, id)] ?? deps.variantForAgent(agent, model)
      const list = Object.keys(deps.findModel(model)?.variants ?? {})
      const variant = value === DEFAULT_VARIANT ? DEFAULT_VARIANT : (preserveVariant(value, list) ?? DEFAULT_VARIANT)
      deps.rememberEffort(agent, model, variant)
    })
  }

  return { selectModel }
}
