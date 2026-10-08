import type { ModelSelection } from "../types/messages"

// fork_change start - model selection state is scoped per session
type Deps = {
  current: () => string
  agent: (sessionID?: string) => string
  selected: (sessionID?: string) => ModelSelection | null
  variant: (sessionID?: string) => string | undefined
  apply: (agent: string, selection: ModelSelection, id: string) => void
  set: (id: string, agent: string, selection: ModelSelection) => void
  carry: (selection: ModelSelection, value: string | undefined, agent: string, sessionID?: string) => void
  hide: (sessionID?: string) => void
}

export function createModelSelector(deps: Deps) {
  const select = (providerID: string, modelID: string, sessionID?: string, remember = true) => {
    const session = sessionID ?? deps.current()
    const agent = deps.agent(session)
    const value = deps.variant(session)
    const selection = { providerID, modelID }
    if (remember) {
      deps.apply(agent, selection, session)
      deps.carry(selection, value, agent, session)
      deps.hide(session)
      return
    }
    deps.set(session, agent, selection)
  }
  const session = (sessionID: string, providerID: string, modelID: string) => {
    const agent = deps.agent(sessionID)
    const value = deps.variant(sessionID)
    const selection = { providerID, modelID }
    // Session allocations must not mutate per-mode picks or push recents.
    deps.set(sessionID, agent, selection)
    deps.carry(selection, value, agent, sessionID)
  }

  return { select, session }
}
// fork_change end
