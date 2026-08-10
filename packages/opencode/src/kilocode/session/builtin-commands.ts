// Built-in session commands surfaced via `kilo run --command <name>` and the TUI
// slash menu that don't live in the Command registry. They map to dedicated
// session endpoints (e.g. `/session/:sessionID/summarize`).
//
// Kept in a side-effect-free module so it can be imported from the server
// (`session/prompt.ts`) without pulling in CLI dependencies.
export const BUILTIN_COMMANDS = ["compact", "summarize", "shake"] as const

export const BUILTIN_COMMAND_DESCRIPTIONS: Record<BuiltinCommand, string> = {
  compact: "compact the session",
  summarize: "summarize the session",
  shake: "clear eligible tool output without invoking an LLM",
}

export const BUILTIN_COMMAND_CATALOG = [
  {
    name: "shake",
    description: BUILTIN_COMMAND_DESCRIPTIONS.shake,
    source: "builtin" as const,
    kind: "action" as const,
  },
]

export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number]

export function isBuiltinCommand(name?: string): name is BuiltinCommand {
  if (!name) return false
  return (BUILTIN_COMMANDS as readonly string[]).includes(name)
}
