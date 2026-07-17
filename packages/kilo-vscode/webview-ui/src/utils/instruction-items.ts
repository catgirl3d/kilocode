import type { Config } from "../types/messages"

type Item = {
  path: string
  enabled: boolean
  kind: "file" | "glob" | "url"
  owned?: boolean
}

type Scope = Pick<Config, "instructions" | "instructions_disabled">

export function list(input: Scope, target?: Scope): Item[] {
  const disabled = new Set(input.instructions_disabled ?? [])
  const paths = [...new Set([...(input.instructions ?? []), ...(target?.instructions ?? [])])]
  const entries = new Set(target?.instructions ?? [])
  const overrides = new Set(target?.instructions_disabled ?? [])
  for (const path of entries) {
    if (overrides.has(path)) {
      disabled.add(path)
      continue
    }
    disabled.delete(path)
  }
  return paths.map((path) => ({
    path,
    enabled: !disabled.has(path),
    kind: kind(path),
    ...(target ? { owned: entries.has(path) || overrides.has(path) } : {}),
  }))
}

export function add(input: Scope, path: string): Partial<Config> {
  const items = input.instructions ?? []
  if (items.includes(path)) return { instructions: items }
  return { instructions: [...items, path] }
}

export function remove(input: Scope, path: string): Partial<Config> {
  return {
    instructions: (input.instructions ?? []).filter((item) => item !== path),
    instructions_disabled: (input.instructions_disabled ?? []).filter((item) => item !== path),
  }
}

export function toggle(input: Scope, path: string, enabled: boolean): Partial<Config> {
  const items = input.instructions_disabled ?? []
  return {
    instructions_disabled: enabled
      ? items.filter((item) => item !== path)
      : items.includes(path)
        ? items
        : [...items, path],
  }
}

export function kind(path: string): Item["kind"] {
  if (/^https?:\/\//i.test(path)) return "url"
  if (
    path.includes("*") ||
    path.includes("?") ||
    path.includes("{") ||
    path.includes("}") ||
    path.includes("[") ||
    path.includes("]")
  )
    return "glob"
  return "file"
}
