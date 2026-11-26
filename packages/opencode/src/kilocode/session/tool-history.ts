// fork_change - new file
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const key = "kilocode.toolHistory"

type RecordValue = Record<string, unknown>
type Done = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }

const local = new Set(["kiloMemory", "sourceMessageID", "background"])

function record(value: unknown): RecordValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as RecordValue
}

function validMetadata(part: SessionV1.Part) {
  if (!("metadata" in part) || part.metadata === undefined) return true
  const metadata = record(part.metadata)
  if (!metadata) return false
  return Object.keys(metadata).every((name) => local.has(name) || name.startsWith("kilocode."))
}

export function cleared(part: SessionV1.Part): boolean {
  if (part.type !== "tool" || part.state.status !== "completed") return false
  const marker = record(record(part.state.metadata)?.[key])
  if (!marker) return false
  return typeof marker.cleared === "number" && Number.isFinite(marker.cleared)
}

export function mark(part: Done, now: number): Done {
  return {
    ...part,
    state: {
      ...part.state,
      metadata: { ...part.state.metadata, [key]: { cleared: now } },
    },
  }
}

export function placeholder(tool: string) {
  const name = tool.length > 64 ? `${tool.slice(0, 61)}...` : tool
  return `[Old ${name} call and result cleared]`
}

export function safe(message: SessionV1.WithParts) {
  if (message.info.role !== "assistant") return false
  for (const part of message.parts) {
    if (!validMetadata(part)) return false
    if (part.type !== "tool") continue
    if (part.tool === "skill" || part.state.status !== "completed") return false
    const metadata = record(part.state.metadata)
    if (!metadata || metadata.providerExecuted === true) return false
  }
  return true
}
