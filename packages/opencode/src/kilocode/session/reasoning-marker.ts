// fork_change - new file
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const key = "kilocode.reasoning"

type Metadata = Record<string, unknown>

function record(value: unknown): Metadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Metadata
}

function metadata(part: SessionV1.Part): Metadata | undefined {
  if (!("metadata" in part)) return undefined
  return record(part.metadata)
}

export function cleared(part: SessionV1.Part): boolean {
  if (part.type !== "reasoning") return false
  const stamp = record(metadata(part)?.[key])?.cleared
  return typeof stamp === "number" && Number.isFinite(stamp)
}

export function mark(part: SessionV1.ReasoningPart, now: number): SessionV1.ReasoningPart {
  return {
    ...part,
    metadata: { ...(record(part.metadata) ?? {}), [key]: { cleared: now } },
  }
}

export function unsupported(part: SessionV1.Part): boolean {
  if (part.type === "reasoning") {
    if ("metadata" in part && part.metadata != null && record(part.metadata) == null) return true
    return Object.keys(metadata(part) ?? {}).some((item) => item !== key)
  }
  if (part.type !== "tool") return false
  const value = record(metadata(part)?.openrouter)
  return value != null && Object.hasOwn(value, "reasoning_details")
}
