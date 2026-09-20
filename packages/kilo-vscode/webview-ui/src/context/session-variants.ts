import type { Accessor } from "solid-js"
import type { AgentConfig, ExtensionMessage, ModelSelection } from "../types/messages"
import {
  DEFAULT_VARIANT,
  getAgentVariant,
  getVariant,
  legacyVariantKey,
  preserveVariant,
  variantKey,
} from "./session-variant-store"

interface Model {
  variants?: Record<string, unknown>
}

type Message = { type: "requestVariants" } | { type: "persistVariant"; key: string; value: string }

interface Options {
  selections: Accessor<Record<string, string>>
  set: (key: string, value: string) => void
  selected: (sessionID?: string) => ModelSelection | null
  session: Accessor<string | undefined>
  agent: (sessionID?: string) => string
  config: (agent: string) => Pick<AgentConfig, "model" | "variant"> | undefined
  find: (selection: ModelSelection) => Model | undefined
  post: (message: Message) => void
  listen: (handler: (message: ExtensionMessage) => void) => () => void
  preferred?: Accessor<(ModelSelection & { variant?: string }) | undefined>
  remember: (agent: string, model: ModelSelection, variant: string) => void
}

export function createSessionVariants(options: Options) {
  const list = (sessionID?: string) => {
    const selection = options.selected(sessionID)
    if (!selection) return []
    return Object.keys(options.find(selection)?.variants ?? {})
  }

  const configured = (name: string, selection: ModelSelection) => {
    const config = options.config(name)
    if (config?.model !== `${selection.providerID}/${selection.modelID}`) return undefined
    return config.variant ?? undefined
  }

  const preferred = (selection: ModelSelection) => {
    const value = options.preferred?.()
    if (value?.providerID !== selection.providerID || value.modelID !== selection.modelID) return undefined
    return value.variant ?? DEFAULT_VARIANT
  }

  const agent = (name: string, selection: ModelSelection | null) => {
    if (!selection) return undefined
    return getAgentVariant(
      options.selections(),
      selection,
      options.find(selection),
      name,
      configured(name, selection),
      preferred(selection),
    )
  }

  // fork_change start - Allow commands to preserve configured target-agent defaults.
  const current = (sessionID?: string, presetFirst = false) => {
    const sid = sessionID ?? options.session()
    const selection = options.selected(sid)
    if (!selection) return undefined
    const variants = list(sid)
    if (variants.length === 0) return undefined
    const name = options.agent(sid)
    return getVariant(
      options.selections(),
      selection,
      variants,
      name,
      sid,
      configured(name, selection),
      preferred(selection),
      presetFirst,
    )
  }

  const request = (sessionID?: string, presetFirst = false) =>
    current(sessionID, presetFirst) ?? (list(sessionID).length > 0 ? DEFAULT_VARIANT : undefined)
  // fork_change end

  const saved = (selection: ModelSelection, name: string, sessionID?: string) =>
    (sessionID ? options.selections()[variantKey(selection, name, sessionID)] : undefined) ??
    preferred(selection) ??
    options.selections()[variantKey(selection, name)] ??
    options.selections()[legacyVariantKey(selection)] ??
    configured(name, selection)

  const choice = (sessionID?: string) => {
    const id = sessionID ?? options.session()
    const model = options.selected(id)
    return model ? saved(model, options.agent(id), id) : undefined
  }

  // fork_change start - Persist explicit picker choices for future tasks.
  const select = (value: string | undefined, sessionID?: string, remember = true) => {
    const sid = sessionID ?? options.session()
    const selection = options.selected(sid)
    if (!selection) return
    const name = options.agent(sid)
    const next = value ?? DEFAULT_VARIANT
    if (!sid && !remember) return
    const key = variantKey(selection, name, sid)
    options.set(key, next)
    if (remember && (!sid || /^(?:sidebar-)?pending:/.test(sid))) {
      options.remember(options.agent(sid), selection, next)
      return
    }
    if (!remember) return
    const remembered = variantKey(selection, name)
    options.set(remembered, next)
    options.post({ type: "persistVariant", key: remembered, value: next })
  }
  // fork_change end

  const carry = (selection: ModelSelection, value: string | undefined, name: string, sessionID?: string) => {
    const list = Object.keys(options.find(selection)?.variants ?? {})
    if (list.length === 0) return
    // fork_change start - Keep an existing target-model choice over inherited values.
    const cached = options.selections()
    if ((value === undefined || value === "max") && cached[variantKey(selection, name)] !== undefined) return
    if (
      (value === undefined || value === "max") &&
      sessionID &&
      cached[variantKey(selection, name, sessionID)] !== undefined
    )
      return
    // fork_change end
    // Undefined leaves the target's effort intact; an explicit Default must be carried.
    const next = value === DEFAULT_VARIANT ? DEFAULT_VARIANT : preserveVariant(value, list)
    if (next === undefined) return
    const key = variantKey(selection, name, sessionID)
    options.set(key, next)
    if (!sessionID) options.post({ type: "persistVariant", key, value: next })
  }

  const load = () => {
    const unsub = options.listen((message) => {
      if (message.type !== "variantsLoaded") return
      for (const [key, value] of Object.entries(message.variants)) {
        if (key.startsWith("session/")) continue
        options.set(key, value)
      }
    })
    options.post({ type: "requestVariants" })
    return unsub
  }

  return { carry, list, agent, current, request, saved, choice, select, load }
}
