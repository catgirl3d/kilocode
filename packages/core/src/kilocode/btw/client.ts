// fork_change - new file
// /btw helpers shared by the TUI and the VS Code webview.

/** A `/btw` line: a side question to ask, or a bare `/btw` that opens the history. */
export function parseBtwCommand(text: string): { kind: "ask"; question: string } | { kind: "history" } | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  const question = (match[1] ?? "").trim()
  if (!question) return { kind: "history" }
  return { kind: "ask", question }
}

/** The side question and answer as a blockquote, ready to paste into a prompt. */
export function quoteBtw(item: { question: string; answer: string }) {
  const question = item.question
    .split("\n")
    .map((line, index) => (index === 0 ? `> **Side question:** ${line}` : `> ${line}`))
  const body = item.answer.split("\n").map((line) => `> ${line}`)
  return `${[...question, ">", ...body].join("\n")}\n\n`
}

// Records only move forward (running -> terminal, answer grows), so whichever copy arrives later, from an event,
// the list or the start response, the more advanced one wins.
export function mergeBtw<T extends { status: string; answer: string }>(current: T | undefined, incoming: T) {
  if (!current) return incoming
  if (current.status !== "running" && incoming.status === "running") return current
  if (current.status === "running" && incoming.status !== "running") return incoming
  return current.answer.length > incoming.answer.length ? current : incoming
}
