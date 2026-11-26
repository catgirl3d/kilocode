import { Agent } from "@/agent/agent"
import { KiloLLM } from "@/kilocode/session/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Effect } from "effect"

const LIMIT = 4
const CHARS = 1_000
const BRANCH_CHARS = 50

// fork_change start - generate and validate conventional type/slug branch names
const TYPES = new Set(["feat", "fix", "chore", "docs", "refactor", "test", "perf", "ci", "build", "style"])

const PROMPT = `Generate a Git branch name for the coherent engineering workstream described by the user's messages.

Return exactly one line:
- a branch name in the form <type>/<slug>, or
- null when there is not yet a clear, stable workstream

<type> must be exactly one of: ${[...TYPES].join(", ")}.
Choose the type that matches the work: feat for new capability, fix for a defect, refactor for behavior-preserving restructuring, and the rest by their usual meaning. Use chore when the task is clear but no other type fits.
<slug> is a short lowercase kebab-case outcome of 2-4 words, about 30 characters or less, so the whole name stays well under 50 characters.
Name the result, not the process. Avoid filler verbs such as "investigate" or "look-into", and vague words such as "mess" or "stuff".
Examples: fix/token-refresh-race, feat/billing-alerts, docs/config-schema.

A pasted issue or pull request link is a concrete work item even without extra text. Do not copy the URL or any part of it:
use its issue or pull request number instead, for example chore/issue-120, and pick the type from any surrounding description; use chore when the type is unknown.

Return null for greetings, acknowledgements, capability questions, casual conversation, vague requests, unresolved brainstorming, or messages that only select an option without enough preceding context.
Return null when the messages only ask a question or check a status and do not describe work to perform (for example "is X fixed?", "check whether ...").
A concrete implementation, investigation, planning, documentation, or research task is a valid workstream.
If the user asks for a specific branch name, prefer that name.
Do not include an explanation, quotes, markdown, or punctuation other than hyphens and the single slash after the type. Do not include a URL.`
// fork_change end

function text(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export function messages(history: MessageV2.WithParts[], latest: string) {
  const prior = history
    .filter((message) => message.info.role === "user")
    .map(text)
    .filter(Boolean)
  const prompt = latest.trim()
  const all = normalize(prior.at(-1) ?? "") === normalize(prompt) || !prompt ? prior : [...prior, prompt]
  return all.slice(-LIMIT).map((message) => message.slice(0, CHARS))
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

// fork_change start - sanitize branch segments and trim on a word boundary
function sanitize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
}

function trim(value: string, limit = BRANCH_CHARS) {
  if (value.length <= limit) return value
  const cut = value.slice(0, Math.max(0, limit))
  const at = cut.lastIndexOf("-")
  return (at > 0 ? cut.slice(0, at) : cut).replace(/-+$/g, "")
}
// fork_change end

export function parse(value: string) {
  const line = value
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
    .split("\n")[0]
    ?.trim()
    .replace(/^['"`]|['"`]$/g, "")
    .toLowerCase()
  if (!line || line === "null") return null

  // fork_change start - reject a pasted link echoed instead of a branch name
  if (line.includes("://") || /^(?:https?|ftp)[-:]/.test(line) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//.test(line))
    return null
  // fork_change end

  // fork_change start - keep one slash and convert legacy flat names
  const at = line.indexOf("/")
  if (at > 0) {
    const type = sanitize(line.slice(0, at))
    if (TYPES.has(type)) {
      const slug = trim(sanitize(line.slice(at + 1)), BRANCH_CHARS - type.length - 1)
      return slug ? `${type}/${slug}` : null
    }
  }

  const flat = sanitize(line)
  if (!flat) return null
  const [type, ...rest] = flat.split("-")
  if (!TYPES.has(type) || rest.length === 0) return trim(flat)
  const slug = trim(rest.join("-"), BRANCH_CHARS - type.length - 1)
  return slug ? `${type}/${slug}` : null
  // fork_change end
}

export const generate = Effect.fn("BranchName.generate")(function* (input: {
  sessionID: SessionID
  messages: string[]
  providerID?: ProviderV2.ID
  modelID?: ModelV2.ID
}) {
  if (input.messages.length === 0) return null

  const provider = yield* Provider.Service
  const llm = yield* LLM.Service
  const ref =
    input.providerID && input.modelID
      ? { providerID: input.providerID, modelID: input.modelID }
      : yield* provider.defaultModel()
  const model =
    (yield* provider.getSmallModel(ref.providerID)) ?? (yield* provider.getModel(ref.providerID, ref.modelID))
  const agent: Agent.Info = {
    name: "branch-name",
    mode: "primary",
    hidden: true,
    options: {},
    permission: [],
    prompt: PROMPT,
    temperature: 0.1,
  }
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: agent.name,
    model: { providerID: model.providerID, modelID: model.id },
  }
  const body = input.messages.map((message, index) => `${index + 1}. ${message}`).join("\n\n")
  const result = yield* KiloLLM.text(
    llm.stream({
      agent,
      user,
      tools: {},
      model,
      small: true,
      messages: [{ role: "user", content: `User messages, oldest to newest:\n\n${body}` }],
      sessionID: `branch-name:${input.sessionID}`,
      system: [],
      retries: 1,
    }),
  )
  return parse(result)
})
