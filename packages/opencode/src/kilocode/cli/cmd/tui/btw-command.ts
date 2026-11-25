// fork_change - new file
const armed = new Map<string, string>()

export function arm(sessionID: string, threadID: string) {
  armed.set(sessionID, threadID)
}

export function take(sessionID: string) {
  const thread = armed.get(sessionID)
  armed.delete(sessionID)
  return thread
}
