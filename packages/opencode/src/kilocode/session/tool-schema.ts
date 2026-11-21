import { asSchema, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { MemoryRedact } from "@kilocode/kilo-memory/redact" // fork_change

const VALUES = { values: true } as const // fork_change

const MAPS = ["$defs", "definitions", "dependencies", "dependentSchemas", "patternProperties", "properties"]
const DANGERS = ["contains", "if", "not", "oneOf"]
const NODES = [
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contentSchema",
  "else",
  "extends",
  "items",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function lookaround(input: string) {
  let inside = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === "\\") {
      i++
      continue
    }
    if (inside) {
      if (char === "]") inside = false
      continue
    }
    if (char === "[") {
      inside = true
      continue
    }
    if (char !== "(") continue
    if (
      input.startsWith("(?=", i) ||
      input.startsWith("(?!", i) ||
      input.startsWith("(?<=", i) ||
      input.startsWith("(?<!", i)
    )
      return true
  }
  return false
}

function reference(input: unknown, danger = false): boolean {
  if (Array.isArray(input)) return input.some((item) => reference(item, danger))
  if (!record(input)) return false
  if (danger && typeof input.$ref === "string") return true
  return Object.entries(input).some(([key, value]) => reference(value, danger || DANGERS.includes(key)))
}

function walk(input: unknown): { value: unknown; changed: boolean; dynamic: boolean; hazard: boolean } {
  if (Array.isArray(input)) {
    const items = input.map(walk)
    const changed = items.some((item) => item.changed)
    return {
      value: changed ? items.map((item) => item.value) : input,
      changed,
      dynamic: items.some((item) => item.dynamic),
      hazard: items.some((item) => item.hazard),
    }
  }
  if (!record(input)) return { value: input, changed: false, dynamic: false, hazard: false }

  const next = { ...input }
  const found = typeof input.pattern === "string" && lookaround(input.pattern)
  if (found) delete next.pattern

  const maps = MAPS.reduce(
    (state, key) => {
      const value = input[key]
      if (!record(value)) return state

      const items = Object.entries(value).map(([name, item]) => {
        const result = walk(item)
        const removed = key === "patternProperties" && lookaround(name)
        return {
          changed: removed || result.changed,
          dynamic: removed || result.dynamic,
          hazard: result.hazard,
          entry: removed ? undefined : ([name, result.value] as const),
        }
      })
      const changed = items.some((item) => item.changed)
      if (changed) next[key] = Object.fromEntries(items.flatMap((item) => (item.entry ? [item.entry] : [])))
      return {
        changed: changed || state.changed,
        dynamic: items.some((item) => item.dynamic) || state.dynamic,
        hazard: items.some((item) => item.hazard) || state.hazard,
      }
    },
    { changed: found, dynamic: false, hazard: false },
  )

  const nodes = NODES.reduce((state, key) => {
    const result = walk(input[key])
    if (result.changed) next[key] = result.value
    return {
      changed: result.changed || state.changed,
      dynamic: result.dynamic || state.dynamic,
      hazard: result.hazard || state.hazard,
    }
  }, maps)

  const dangers = DANGERS.reduce((state, key) => {
    const result = walk(input[key])
    if (result.changed) next[key] = result.value
    return {
      changed: result.changed || state.changed,
      dynamic: result.dynamic || state.dynamic,
      hazard: result.changed || result.hazard || state.hazard,
    }
  }, nodes)
  return { value: dangers.changed ? next : input, ...dangers }
}

// fork_change start - Values mode scrubs free-text descriptions and rejects keys in the tool contract.
/**
 * Scrub free-text descriptions in a copy of a JSON schema. Every other string is part of the
 * tool contract (property name, enum, default, pattern, ...), so a recognized key there throws
 * instead of being rewritten.
 */
export function redact(input: unknown): unknown {
  if (typeof input === "string") {
    if (MemoryRedact.has(input, VALUES)) throw new MemoryRedact.Failure()
    return input
  }
  if (Array.isArray(input)) return input.map(redact)
  if (!record(input)) return input
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (MemoryRedact.has(key, VALUES)) throw new MemoryRedact.Failure()
    next[key] = key === "description" && typeof value === "string" ? MemoryRedact.text(value, VALUES) : redact(value)
  }
  return next
}
// fork_change end

// fork_change start - Accept the schema-redaction flag from the caller.
export async function sanitize(input: Record<string, Tool>, redactKeys = false): Promise<Record<string, Tool>> {
  // fork_change end
  const items = await Promise.all(
    Object.entries(input).map(async ([name, item]) => {
      // fork_change start - Check tool names and scrub descriptions only when enabled.
      if (redactKeys && MemoryRedact.has(name, VALUES)) throw new MemoryRedact.Failure()
      const desc = redactKeys
        ? {
            description:
              typeof item.description === "string" ? MemoryRedact.text(item.description, VALUES) : item.description,
          }
        : {}
      if (item.type === "provider") return { name, tool: redactKeys ? { ...item, ...desc } : item, changed: redactKeys }
      // fork_change end
      const source = asSchema(item.inputSchema)
      const original = await source.jsonSchema
      const result = walk(redactKeys ? redact(original) : original) // fork_change
      if (!redactKeys && !result.changed) return { name, tool: item, changed: false } // fork_change
      // Tool inputs are object-root schemas. Complex widening falls back to accepting any object.
      const fallback = result.changed && (result.dynamic || result.hazard || reference(original)) // fork_change
      const schema = fallback ? { type: "object" as const, additionalProperties: true } : result.value
      return {
        name,
        tool: { ...item, ...desc, inputSchema: jsonSchema(schema as JSONSchema7, { validate: source.validate }) }, // fork_change
        changed: true,
      }
    }),
  )
  if (!redactKeys && !items.some((item) => item.changed)) return input // fork_change
  return Object.fromEntries(items.map((item) => [item.name, item.tool]))
}

export * as KiloToolSchema from "./tool-schema"
