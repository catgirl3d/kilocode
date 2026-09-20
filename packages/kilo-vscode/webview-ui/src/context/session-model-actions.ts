// fork_change - new file
import { batch } from "solid-js"
import type { ModelSelection } from "../types/messages"
import { preserveVariant, variantKey } from "./session-variant-store"
import type { createModelSelector } from "./session-model-selector"
import type { createSessionVariants } from "./session-variants"
import type { useProvider } from "./provider"

interface Deps {
  select: ReturnType<typeof createModelSelector>["select"]
  agentForScope: (sessionID?: string) => string
  currentSessionID: () => string | undefined
  variantSelections: () => Record<string, string>
  variantForAgent: ReturnType<typeof createSessionVariants>["agent"]
  findModel: ReturnType<typeof useProvider>["findModel"]
  rememberSelection: (agent: string, model: ModelSelection, value: string | undefined) => void
}

export function createSessionModelActions(deps: Deps) {
  function selectModel(providerID: string, modelID: string, sessionID?: string, remember = true) {
    const id = sessionID ?? deps.currentSessionID()
    batch(() => {
      deps.select(providerID, modelID, id)
      if (remember && (!id || /^(?:sidebar-)?pending:/.test(id))) {
        const model = { providerID, modelID }
        const agent = deps.agentForScope(id)
        const value = deps.variantSelections()[variantKey(model, agent, id)] ?? deps.variantForAgent(agent, model)
        const list = Object.keys(deps.findModel(model)?.variants ?? {})
        deps.rememberSelection(agent, model, value === "" ? "" : preserveVariant(value, list))
      }
    })
  }

  return { selectModel }
}
