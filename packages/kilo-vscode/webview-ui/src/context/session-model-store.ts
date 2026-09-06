import type { ModelSelection, Provider } from "../types/messages"
import { resolveModelSelection } from "./model-selection"

/**
 * Pure-logic helpers for per-session and global model selection.
 *
 * The SessionProvider delegates to these so the core state transitions
 * can be tested without SolidJS reactivity.
 */

export interface ModelStore {
  /** agentName -> model (global, extension-lifetime) */
  modelSelections: Record<string, ModelSelection | null>
  /** sessionID -> per-session model override */
  sessionOverrides: Record<string, ModelSelection>
  /** sessionID -> agent name */
  agentSelections: Record<string, string>
  recentModels: ModelSelection[]
  userSetAgents?: Record<string, boolean>
}

export interface ResolveEnv {
  providers: Record<string, Provider>
  connected: string[]
  ready?: boolean
  organizationId?: string | null
  defaults?: Record<string, string>
  fallback: ModelSelection | null
  getModeModel: (agentName: string) => ModelSelection | null
  getGlobalModel: () => ModelSelection | null
}

function resolveModel(
  env: ResolveEnv,
  agentName: string,
  override?: ModelSelection | null,
  recents?: ModelSelection[],
  session?: ModelSelection,
): ModelSelection | null {
  return resolveModelSelection({
    providers: env.providers,
    connected: env.connected,
    ready: env.ready,
    organizationId: env.organizationId,
    defaults: env.defaults,
    session,
    override,
    mode: env.getModeModel(agentName),
    global: env.getGlobalModel(),
    recent: recents,
    fallback: env.fallback,
  })
}

/**
 * Returns the model for a specific session, honoring per-session overrides.
 *
 * Precedence: sessionOverride > global modelSelections[agent] > config/default.
 */
export function getSessionModel(
  store: ModelStore,
  env: ResolveEnv,
  sessionID: string,
  defaultAgent: string,
): ModelSelection | null {
  const agentName = store.agentSelections[sessionID] ?? defaultAgent
  return getSelected(store, env, sessionID, agentName)
}

/**
 * Returns the model for the "current" view (model picker display).
 *
 * Precedence: sessionOverride[sid] > global modelSelections[agent] > config/default.
 */
export function getSelected(
  store: ModelStore,
  env: ResolveEnv,
  sessionID: string | undefined,
  agentName: string,
): ModelSelection | null {
  const override = env.organizationId && !store.userSetAgents?.[agentName] ? null : store.modelSelections[agentName]
  return resolveModel(
    env,
    agentName,
    override,
    store.recentModels,
    sessionID ? store.sessionOverrides[sessionID] : undefined,
  )
}

/** Returns the effective model for a mode outside a session scope. */
export function getAgentModel(
  store: ModelStore,
  env: ResolveEnv,
  agentName: string,
  userSet = store.userSetAgents?.[agentName] === true,
): ModelSelection | null {
  const override =
    (env.getModeModel(agentName) && userSet) || (env.organizationId && !userSet)
      ? null
      : store.modelSelections[agentName]
  return resolveModel(env, agentName, override, store.recentModels)
}

export interface ApplyResult {
  modelSelections: Record<string, ModelSelection | null>
  sessionOverrides: Record<string, ModelSelection>
  userSetAgents: Record<string, boolean>
}

// fork_change start - Persist active model picks unless explicitly temporary.
/**
 * Apply a user-initiated model selection.
 *
 * Remembered selections write to the per-mode modelSelections map, while
 * session-scoped selections also write to the per-session override.
 * Temporary callers can disable the remembered selection.
 */
export function applyModel(
  store: ModelStore,
  agentName: string,
  selection: ModelSelection,
  sessionID: string | undefined,
  remember = true,
): ApplyResult {
  const modelSelections = remember ? { ...store.modelSelections, [agentName]: selection } : { ...store.modelSelections }
  const sessionOverrides = { ...store.sessionOverrides }

  if (sessionID) {
    sessionOverrides[sessionID] = selection
  }

  const userSetAgents = remember ? { ...store.userSetAgents, [agentName]: true } : { ...store.userSetAgents }
  return { modelSelections, sessionOverrides, userSetAgents }
}
// fork_change end
