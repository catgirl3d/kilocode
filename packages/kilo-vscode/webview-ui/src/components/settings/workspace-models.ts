// fork_change - new file
import { createMemo } from "solid-js"
import { useConfig } from "../../context/config"
import type { AgentConfig, Config } from "../../types/messages"
import { deepMerge, stripNulls } from "../../utils/config-utils"

const TOP = ["model", "small_model", "subagent_model", "subagent_variant", "subagent_variant_overrides"] as const
const ADVISOR = ["advisors", "advisor_model", "advisor_variant"] as const
const AGENT = ["model", "variant"] as const

function defined(value: unknown) {
  return value !== undefined && value !== null
}

function pick<T extends object, K extends keyof T>(source: T | undefined, keys: readonly K[]) {
  const result: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    const value = source?.[key]
    if (defined(value)) result[key] = value
  }
  return result
}

function unset<T extends object, K extends keyof T>(source: T | undefined, keys: readonly K[]) {
  const result: Partial<Record<K, null>> = {}
  for (const key of keys) {
    if (defined(source?.[key])) result[key] = null
  }
  return result
}

function agents(agent: Config["agent"], part: (item: AgentConfig) => Partial<AgentConfig>) {
  return Object.fromEntries(
    Object.entries(agent ?? {}).flatMap(([name, item]) => {
      const value = part(item)
      return Object.keys(value).length > 0 ? [[name, value] as const] : []
    }),
  )
}

/** True when the workspace config already defines a model choice that this tab edits. */
export function pinned(project: Config) {
  return (
    TOP.some((key) => defined(project[key])) ||
    ADVISOR.some((key) => defined(project.experimental?.[key])) ||
    Object.values(project.agent ?? {}).some((item) => AGENT.some((key) => defined(item[key])))
  )
}

/** Patch that copies the effective model choices into the workspace config. */
export function snapshot(config: Config): Partial<Config> {
  const exp = pick(config.experimental, ADVISOR)
  const agent = agents(config.agent, (item) => pick(item, AGENT))
  return {
    ...pick(config, TOP),
    ...(Object.keys(exp).length > 0 ? { experimental: exp } : {}),
    ...(Object.keys(agent).length > 0 ? { agent } : {}),
  }
}

/** Patch that unsets the model choices the workspace config currently defines. */
export function release(project: Config): Partial<Config> {
  const exp = unset(project.experimental, ADVISOR)
  const agent = agents(project.agent, (item) => unset(item, AGENT))
  return {
    ...unset(project, TOP),
    ...(Object.keys(exp).length > 0 ? { experimental: exp } : {}),
    ...(Object.keys(agent).length > 0 ? { agent } : {}),
  }
}

export function useModelScope() {
  const cfg = useConfig()
  const pin = createMemo(() => pinned(cfg.projectConfig()))
  // Effective config plus pending workspace edits, so the tab shows what it will save.
  const config = createMemo(() =>
    pin() ? stripNulls(deepMerge(cfg.config(), cfg.projectDraft?.() ?? {})) : cfg.config(),
  )
  const update = (partial: Partial<Config>) => (pin() ? cfg.updateProjectConfig(partial) : cfg.updateConfig(partial))
  const toggle = (on: boolean) => cfg.updateProjectConfig(on ? snapshot(cfg.config()) : release(cfg.projectConfig()))
  return { pinned: pin, config, update, toggle, available: () => !!cfg.projectBinding() }
}
