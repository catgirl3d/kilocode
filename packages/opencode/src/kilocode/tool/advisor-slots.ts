// fork_change - new file
import type { Def } from "@/tool/tool"

const LIMIT = 3
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
const SUMMARY = 200

export const PROMPT_LIMIT = 20_000

export type Slot = {
  name: string
  description?: string
  prompt?: string
  model: string
  variant?: string
}

export type Source = {
  readonly advisors?: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly prompt?: string
    readonly model: string
    readonly variant?: string
  }>
  readonly advisor_model?: string
  readonly advisor_variant?: string
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Normalize configured advisor slots; the schema stays lenient so bad entries are skipped here. */
export function resolve(cfg?: Source): Slot[] {
  const seen = new Set<string>()
  const list = Array.isArray(cfg?.advisors) ? cfg.advisors : []
  const slots = list.slice(0, LIMIT).flatMap((item): Slot[] => {
    if (!text(item?.model)) return []
    if (typeof item.name !== "string" || !NAME.test(item.name) || seen.has(item.name)) return []
    seen.add(item.name)
    return [
      {
        name: item.name,
        model: item.model,
        description: text(item.description),
        prompt: text(item.prompt),
        variant: text(item.variant),
      },
    ]
  })
  if (slots.length > 0) return slots
  const model = cfg?.advisor_model
  if (!model) return []
  return [{ name: "advisor", model, variant: cfg?.advisor_variant }]
}

/** Pick the slots for one call: the first slot by default, every slot for "all", otherwise the named ones. */
export function select(slots: Slot[], input?: "all" | ReadonlyArray<string>): { slots: Slot[] } | { unknown: string } {
  if (input === undefined) return { slots: slots.slice(0, 1) }
  if (input === "all") return { slots }
  const names = [...new Set(input)]
  const unknown = names.find((name) => !slots.some((slot) => slot.name === name))
  if (unknown !== undefined) return { unknown }
  return { slots: names.flatMap((name) => slots.filter((slot) => slot.name === name)) }
}

/** Extend the advisor tool description with slot names and short descriptions, never role prompts. */
export function describe(def: Def, slots: Slot[]): Def {
  const list = slots.map((slot) => {
    const summary = slot.description?.replace(/\s+/g, " ").trim().slice(0, SUMMARY)
    return summary ? `- ${slot.name}: ${summary}` : `- ${slot.name}`
  })
  return {
    ...def,
    description: [
      def.description.trimEnd(),
      "",
      'Configured advisors (pass names in `advisors`, or "all"; without it the first one answers; each additional advisor is a separate model call):',
      ...list,
    ].join("\n"),
  }
}
