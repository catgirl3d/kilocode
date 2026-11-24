// fork_change - new file
import type { Config } from "../../types/messages"
import { preserveVariant } from "../../context/session-variant-store"

export function subagentModelPatch(
  config: Pick<Config, "subagent_model" | "subagent_variant" | "subagent_variant_overrides">,
  providerID: string,
  modelID: string,
  variants: string[],
): Partial<Config> {
  if (!providerID || !modelID) return { subagent_model: null, subagent_variant: null }

  const value = `${providerID}/${modelID}`
  const current = config.subagent_model
    ? (config.subagent_variant_overrides?.[config.subagent_model] ?? config.subagent_variant)
    : undefined
  const next = preserveVariant(current ?? undefined, variants)

  return {
    subagent_model: value,
    ...(config.subagent_model === value ? {} : { subagent_variant: null }),
    ...(next ? { subagent_variant_overrides: { ...config.subagent_variant_overrides, [value]: next } } : {}),
  }
}
