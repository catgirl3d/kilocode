import type { Message, Part, SessionInfo, TodoItem, ToolPart } from "../types/messages"

type Revert = NonNullable<SessionInfo["revert"]>
type Source = Record<string, Part[]> | ((messageID: string) => Part[] | undefined)
type TodoPart = ToolPart & { state: { status: "completed"; metadata?: Record<string, unknown> } }

interface Input {
  messages: Message[]
  parts: Source
  revert?: Revert
}

interface Write {
  part: TodoPart
  todos: TodoItem[]
}

function list(source: Source, messageID: string) {
  if (typeof source === "function") return source(messageID) ?? []
  return source[messageID] ?? []
}

export function isTodo(part: Part): part is TodoPart {
  if (part.type !== "tool") return false
  if (part.tool !== "todowrite") return false
  if (part.state.status !== "completed") return false
  return true
}

export function items(part: Part): TodoItem[] | undefined {
  if (!isTodo(part)) return undefined
  const todos = part.state.metadata?.todos
  if (!Array.isArray(todos)) return undefined
  return todos as TodoItem[]
}

// fork_change start
function active(input: Input, index: number) {
  const msg = input.messages[index]!
  // fork_change end
  const parts = list(input.parts, msg.id)
  const revert = input.revert
  if (!revert) return parts
  // fork_change start
  const boundary = input.messages.findIndex((item) => item.id === revert.messageID)
  if (boundary < 0 || index < boundary) return parts
  if (index > boundary) return []
  // fork_change end
  if (!revert.partID) return []
  // fork_change start
  const part = parts.findIndex((item) => item.id === revert.partID)
  return part < 0 ? [] : parts.slice(0, part)
  // fork_change end
}

export function writes(input: Input): Write[] {
  // fork_change start
  return input.messages.flatMap((_msg, index) =>
    active(input, index).flatMap((part) => {
      // fork_change end
      const todos = items(part)
      return todos ? [{ part: part as TodoPart, todos }] : []
    }),
  )
}

export function state(input: Input): TodoItem[] {
  return writes(input).at(-1)?.todos ?? []
}
