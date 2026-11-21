import { asSchema, type ModelMessage, type Tool } from "ai"
import { isRecord } from "@/util/record"
// fork_change start - outbound access key redaction before the decide call
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { KiloLLM } from "@/kilocode/session/llm"
import { redact as redactSchema } from "@/kilocode/session/tool-schema"
// fork_change end

type Options = { redact?: boolean } // fork_change

// ADR 0005: the routing worker classifies the request exactly as the gateway
// does, so client decisions and gateway decisions share one normalization. The
// worker receives OpenAI-format messages and tools, built here from the
// AI SDK message list the session already assembled.
// fork_change start - accept the optional redaction policy
export function openaiMessages(messages: ReadonlyArray<ModelMessage>, options?: Options): unknown[] {
  // fork_change end
  const redact = options?.redact === true // fork_change
  const out: unknown[] = []
  // fork_change start - Apply the redaction policy before message conversion.
  for (const message of redact ? KiloLLM.messages(messages, true) : messages) {
    // fork_change end
    if (message.role === "system") {
      out.push({ role: "system", content: text(message.content) })
      continue
    }
    if (message.role === "user") {
      out.push({ role: "user", content: userContent(message.content) })
      continue
    }
    if (message.role === "assistant") {
      out.push(assistantContent(message.content))
      continue
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      out.push({
        role: "tool",
        tool_call_id: part.toolCallId,
        content: toolResult(part.output),
      })
    }
  }
  return out
}

// fork_change start - accept the optional redaction policy
export async function openaiTools(tools: Record<string, Tool>, options?: Options): Promise<unknown[]> {
  // fork_change end
  const redact = options?.redact === true // fork_change
  return Promise.all(
    // fork_change start - Convert each tool to its OpenAI shape with scrubbed text.
    Object.entries(tools).map(async ([name, tool]) => {
      const parameters = await asSchema(tool.inputSchema).jsonSchema
      const description = tool.description ?? ""
      return {
        type: "function",
        function: {
          name: redact ? contract(name) : name,
          description: redact ? MemoryRedact.text(description, VALUES) : description,
          parameters: redact ? redactSchema(parameters) : parameters,
        },
      }
    }),
    // fork_change end
  )
}

// fork_change start - Share values-mode redaction options and reject key-like tool names in the tool contract.
const VALUES = { values: true } as const

// A tool name is part of the wire contract, so a recognized key there cannot be rewritten.
function contract(input: string) {
  if (MemoryRedact.has(input, VALUES)) throw new MemoryRedact.Failure()
  return input
}
// fork_change end

function text(content: unknown): string {
  if (typeof content === "string") return content
  return typeof content === "undefined" ? "" : JSON.stringify(content)
}

function userContent(content: unknown): string | unknown[] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return text(content)
  const parts: unknown[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "image") {
      const url = dataUrl(part.image, typeof part.mediaType === "string" ? part.mediaType : "image/jpeg")
      if (url) parts.push({ type: "image_url", image_url: { url } })
      continue
    }
    if (part.type === "file" && typeof part.mediaType === "string") {
      const file = filePart(part.data, part.mediaType, typeof part.filename === "string" ? part.filename : "")
      if (file) parts.push(file)
    }
  }
  return parts.length > 0 ? parts : ""
}

// Mirrors the gateway provider's file conversion (@openrouter/ai-sdk-provider),
// so the classifier sees the attachment the selected model receives.
function filePart(data: unknown, mime: string, filename: string): unknown {
  const url = dataUrl(data, mime)
  if (!url) return undefined
  if (mime.startsWith("image/")) return { type: "image_url", image_url: { url } }
  if (mime.startsWith("video/")) return { type: "video_url", video_url: { url } }
  if (mime.startsWith("audio/")) {
    // The gateway provider rejects an unmapped format; the classifier skips that part.
    const sub = mime.slice("audio/".length)
    if (!Object.hasOwn(AUDIO_FORMATS, sub)) return undefined
    const format = AUDIO_FORMATS[sub]
    return { type: "input_audio", input_audio: { data: url.replace(/^data:[^;]*;base64,/, ""), format } }
  }
  return { type: "file", file: { filename, file_data: url } }
}

// Copy of MIME_TO_FORMAT in @openrouter/ai-sdk-provider.
const AUDIO_FORMATS: Record<string, string> = {
  mpeg: "mp3",
  mp3: "mp3",
  "x-wav": "wav",
  wave: "wav",
  wav: "wav",
  ogg: "ogg",
  vorbis: "ogg",
  aac: "aac",
  "x-aac": "aac",
  m4a: "m4a",
  "x-m4a": "m4a",
  mp4: "m4a",
  aiff: "aiff",
  "x-aiff": "aiff",
  flac: "flac",
  "x-flac": "flac",
  pcm16: "pcm16",
  pcm24: "pcm24",
}

function dataUrl(data: unknown, mime: string): string | undefined {
  if (data instanceof URL) return data.toString()
  if (typeof data === "string") return /^(data|https?):/i.test(data) ? data : `data:${mime};base64,${data}`
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return `data:${mime};base64,${Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("base64")}`
  }
  return undefined
}

function assistantContent(content: unknown): unknown {
  if (typeof content === "string") return { role: "assistant", content }
  if (!Array.isArray(content)) return { role: "assistant", content: text(content) }
  const textParts: string[] = []
  const calls: unknown[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text)
      continue
    }
    if (part.type === "tool-call") {
      calls.push({
        id: part.toolCallId,
        type: "function",
        function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
      })
    }
  }
  return {
    role: "assistant",
    content: textParts.join("\n"),
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  }
}

function toolResult(output: unknown): string {
  if (!isRecord(output)) return text(output)
  if (output.type === "text" || output.type === "error-text") {
    return typeof output.value === "string" ? output.value : text(output.value)
  }
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value)
  return JSON.stringify(output.value ?? output)
}
