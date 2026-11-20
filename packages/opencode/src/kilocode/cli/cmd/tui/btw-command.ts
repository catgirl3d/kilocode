// fork_change - new file
export function parseBtwCommand(text: string) {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  const question = (match[1] ?? "").trim()
  if (!question) return { kind: "history" as const }
  return { kind: "ask" as const, question }
}

export function quote(item: { question: string; answer: string }) {
  const lines = item.question.split("\n")
  const head = `> **Side question:** ${lines.at(0)}`
  const rest = lines.slice(1).map((line) => `> ${line}`)
  const body = item.answer.split("\n").map((line) => `> ${line}`)
  return `${[head, ...rest, ">", ...body].join("\n")}\n\n`
}

const armed = new Map<string, string>()

export function arm(sessionID: string, threadID: string) {
  armed.set(sessionID, threadID)
}

export function take(sessionID: string) {
  const thread = armed.get(sessionID)
  armed.delete(sessionID)
  return thread
}
