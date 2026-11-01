// fork_change - new file
type Kind = "reasoning" | "tools"

type Memory = {
  getState: <T>() => T | undefined
  setState: <T>(state: T) => void
}

const KEY = "clearKeepTurns"
const DEFAULT = 10

function valid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
}

function saved(memory: Memory): Record<string, unknown> {
  const value = memory.getState<Record<string, unknown>>()?.[KEY]
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** Last confirmed keep-turns of a clear dialog, shared by every session of this webview. */
export function recallKeepTurns(memory: Memory, kind: Kind): number {
  const value = saved(memory)[kind]
  return valid(value) ? value : DEFAULT
}

export function rememberKeepTurns(memory: Memory, kind: Kind, value: number) {
  if (!valid(value)) return
  memory.setState({ ...memory.getState<Record<string, unknown>>(), [KEY]: { ...saved(memory), [kind]: value } })
}
