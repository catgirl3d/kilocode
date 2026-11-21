// fork_change - new file
import { MemoryRedact } from "@kilocode/kilo-memory/redact"

const VALUES = { values: true } as const
const MARKER = "[redacted]"

type Part = { type: string; text?: unknown; ignored?: unknown; state?: unknown }

type State = {
  status?: unknown
  output?: unknown
  error?: unknown
  time?: { compacted?: unknown }
  metadata?: { interrupted?: unknown; output?: unknown }
}

const markers = (text: string) => text.split(MARKER).length - 1

/** Personal policy, read like the CLI reads it: only the global config decides, absent means on. */
export function redacting(config: { experimental?: { redact_secrets?: boolean } } | undefined) {
  return config?.experimental?.redact_secrets !== false
}

/** Secrets the CLI hides in these texts, found with the same values-mode matcher it sends with. */
export function count(texts: ReadonlyArray<string>) {
  return texts.reduce((sum, text) => sum + markers(MemoryRedact.text(text, VALUES)) - markers(text), 0)
}

/** Text a user message sends to the model: non-empty text parts that are not ignored, synthetic file text included. */
export function user(parts: ReadonlyArray<Part>) {
  return parts.flatMap((part) =>
    part.type === "text" && part.ignored !== true && typeof part.text === "string" && part.text !== ""
      ? [part.text]
      : [],
  )
}

/** Text a tool part sends back to the model; a result cleared by compaction sends a placeholder instead. */
export function tool(part: Part) {
  if (part.type !== "tool" || typeof part.state !== "object" || part.state === null) return []
  const state = part.state as State
  if (state.status === "completed") {
    return state.time?.compacted || typeof state.output !== "string" ? [] : [state.output]
  }
  if (state.status !== "error") return []
  if (state.metadata?.interrupted === true && typeof state.metadata.output === "string") return [state.metadata.output]
  return typeof state.error === "string" ? [state.error] : []
}
