import type { ModelMessage } from "ai"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import type { Logger } from "@opencode-ai/core/util/log"
import { MemoryRedact } from "@kilocode/kilo-memory/redact" // fork_change
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { isRecord } from "@/util/record" // fork_change
import { KiloSessionOverflow } from "./overflow"

const SAFETY = 2048
const MIN_OUTPUT = 1024
const CLAUDE = new Set([
  "@kilocode/kilo-gateway",
  "@ai-sdk/anthropic",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/google-vertex/anthropic",
])

export namespace KiloLLM {
  // fork_change start - outbound access key redaction helpers
  const VALUES = { values: true } as const
  // Opaque provider state: readable text next to one of these cannot be rewritten.
  const OPAQUE = new Set(["signature", "redactedData", "redactedContent"])
  // Provider option fields that carry model-readable text rather than auth or opaque state.
  const REASONING = new Set(["reasoning_content", "reasoningContent", "reasoning", "reasoning_details"])

  /** Personal policy: only the global config decides, absent or unreadable means enabled. */
  export function enabled(config: { experimental?: { redact_secrets?: boolean } } | undefined): boolean {
    return config?.experimental?.redact_secrets !== false
  }

  function immutable(value: string) {
    if (MemoryRedact.has(value, VALUES)) throw new MemoryRedact.Failure()
  }

  function signed(input: unknown): boolean {
    if (Array.isArray(input)) return input.some(signed)
    if (!isRecord(input)) return false
    if (input.type === "reasoning.encrypted") return true
    return Object.entries(input).some(([key, value]) => (OPAQUE.has(key) && value != null) || signed(value))
  }

  // A recognized key in an object property key cannot be hidden without changing the contract.
  function keys(input: unknown) {
    if (Array.isArray(input)) {
      for (const item of input) keys(item)
      return
    }
    if (!isRecord(input)) return
    for (const [key, value] of Object.entries(input)) {
      immutable(key)
      keys(value)
    }
  }

  function json(input: unknown) {
    keys(input)
    return MemoryRedact.value(input, undefined, VALUES)
  }

  function part(input: unknown, invalidate: () => void): unknown {
    if (!isRecord(input)) return input
    const next = partOptions(input, invalidate)
    if ((input.type === "text" || input.type === "reasoning") && typeof input.text === "string") {
      const text = MemoryRedact.text(input.text, VALUES)
      if (text === input.text) return next
      if (input.type === "reasoning" && signed(input.providerOptions)) invalidate()
      return { ...next, text }
    }
    if (input.type === "tool-call") {
      if (typeof input.toolName === "string") immutable(input.toolName)
      if (typeof input.toolCallId === "string") immutable(input.toolCallId)
      return { ...next, input: json(input.input) }
    }
    if (input.type === "tool-result") {
      if (typeof input.toolCallId === "string") immutable(input.toolCallId)
      if (typeof input.toolName === "string") immutable(input.toolName)
      return { ...next, output: result(input.output, invalidate) }
    }
    return next
  }

  function result(input: unknown, invalidate: () => void): unknown {
    if (!isRecord(input)) return input
    if ((input.type === "text" || input.type === "error-text") && typeof input.value === "string") {
      const text = MemoryRedact.text(input.value, VALUES)
      return text === input.value ? input : { ...input, value: text }
    }
    if (input.type === "json" || input.type === "error-json") return { ...input, value: json(input.value) }
    if (input.type === "execution-denied" && typeof input.reason === "string") {
      const text = MemoryRedact.text(input.reason, VALUES)
      return text === input.reason ? input : { ...input, reason: text }
    }
    if (input.type === "content" && Array.isArray(input.value)) {
      return { ...input, value: input.value.map((item) => part(item, invalidate)) }
    }
    return input
  }

  function content(input: unknown, invalidate: () => void): unknown {
    if (typeof input === "string") return MemoryRedact.text(input, VALUES)
    // Image, file and media parts are sent as opaque bytes and stay untouched.
    return Array.isArray(input) ? input.map((item) => part(item, invalidate)) : input
  }

  /** A scrubbed copy of the messages; the input and its parts are never mutated. */
  export function messages(input: ReadonlyArray<ModelMessage>, redact: boolean): ModelMessage[] {
    if (!redact) return input as ModelMessage[]
    // Tool media may be replayed as a synthetic user message within the same turn.
    const starts = (message: ModelMessage, index: number) =>
      message.role === "user" && (index === 0 || input.at(index - 1)?.role !== "tool")
    const turn = input.findLastIndex(starts)
    let last = -1
    const next = input.map((message, index) => {
      immutable(message.role)
      const invalidate = () => {
        if (message.role !== "assistant" || index >= turn) throw new MemoryRedact.Failure()
        last = index
      }
      return partOptions(
        { ...message, content: content(message.content, invalidate) },
        invalidate,
      ) as unknown as ModelMessage
    })
    if (last < 0) return next
    // Drop a prefix of whole turns, never a signed block between two kept blocks.
    const end = input.findIndex((message, index) => index > last && starts(message, index))
    return next.flatMap((message, index): ModelMessage[] => {
      if (index >= end || message.role !== "assistant") return [message]
      const trimmed = strip(message)
      if (!Array.isArray(trimmed.content)) return [trimmed]
      const parts = trimmed.content.filter((item) => item.type !== "reasoning" || !signed(item.providerOptions))
      if (parts.length === 0 && trimmed.content.length > 0) return []
      return [{ ...trimmed, content: parts.map(strip) }]
    })
  }

  /** Scrubbed copy of the system instruction strings. */
  export function system(input: ReadonlyArray<string>, redact: boolean): string[] {
    if (!redact) return input as string[]
    return input.map((item) => MemoryRedact.text(item, VALUES))
  }

  // Known textual provider-option fields (`instructions`, readable reasoning) are scrubbed;
  // auth headers, MIME bytes and opaque state keep their values.
  function options(input: unknown): unknown {
    if (Array.isArray(input)) {
      const next = input.map(options)
      return next.some((item, index) => item !== input[index]) ? next : input
    }
    if (!isRecord(input)) return input
    // OpenRouter replays reasoning detail entries; both the text and the summary are model-readable.
    const reasoning = typeof input.type === "string" && input.type.startsWith("reasoning")
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      const item =
        typeof value === "string" &&
        (key === "instructions" || REASONING.has(key) || (reasoning && (key === "text" || key === "summary")))
          ? MemoryRedact.text(value, VALUES)
          : options(value)
      if (item !== value) changed = true
      next[key] = item
    }
    return changed ? next : input
  }

  // Provider options carry replay state on messages and parts, including tool calls.
  function partOptions(input: Record<string, unknown>, invalidate: () => void): Record<string, unknown> {
    if (!("providerOptions" in input)) return input
    const value = input.providerOptions
    const next = options(value)
    if (next === value) return input
    if (signed(value)) invalidate()
    return { ...input, providerOptions: next }
  }

  function unsigned(input: Record<string, unknown>): Record<string, unknown> {
    const opaque = Object.entries(input).some(([key, value]) => OPAQUE.has(key) && value != null)
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (OPAQUE.has(key) || (opaque && REASONING.has(key))) continue
      if (key === "reasoning_details" && signed(value)) continue
      if (isRecord(value) && signed(value)) {
        const clean = unsigned(value)
        if (Object.keys(clean).length > 0) next[key] = clean
        continue
      }
      next[key] = value
    }
    return next
  }

  function strip<T extends object>(input: T): T {
    if (!("providerOptions" in input)) return input
    if (!isRecord(input.providerOptions) || !signed(input.providerOptions)) return input
    const next = unsigned(input.providerOptions)
    const copy = { ...input }
    delete copy.providerOptions
    return Object.keys(next).length > 0 ? { ...copy, providerOptions: next } : copy
  }

  /**
   * Final pass after ProviderTransform: the actual text leaves and known textual provider-option
   * fields are checked again with the same values mode, so a second step never resends an original.
   */
  export function final(input: {
    messages: ReadonlyArray<ModelMessage>
    providerOptions?: Record<string, unknown>
    redact: boolean
  }): { messages: ModelMessage[]; providerOptions?: Record<string, unknown> } {
    if (!input.redact) return { messages: input.messages as ModelMessage[], providerOptions: input.providerOptions }
    return {
      messages: messages(input.messages, true),
      providerOptions:
        input.providerOptions === undefined ? undefined : (options(input.providerOptions) as Record<string, unknown>),
    }
  }
  // fork_change end

  // Stream failures and interruptions propagate while text deltas are collected.
  export function text(stream: Stream.Stream<LLMEvent, unknown>) {
    return stream.pipe(
      Stream.map((event) => (event.type === "text-delta" ? event.text : "")),
      Stream.mkString,
    )
  }

  export function timeout(input: {
    options: Record<string, unknown>
    fallback?: Record<string, unknown>
    log?: Pick<Logger, "debug">
  }): { timeout?: { chunkMs: number } } {
    const value =
      typeof input.options["chunkTimeout"] === "number"
        ? input.options["chunkTimeout"]
        : typeof input.fallback?.["chunkTimeout"] === "number"
          ? input.fallback["chunkTimeout"]
          : undefined
    if (!value) return {}
    input.log?.debug("chunk idle timeout configured", { chunkTimeout: value })
    return { timeout: { chunkMs: value } }
  }

  /**
   * Requested output tokens for one step.
   *
   * Claude counts thinking tokens inside `max_tokens`. With adaptive thinking
   * there is no separate budget that the AI SDK adds on top, so the shared
   * 32k default can be used up by thinking before any text or tool call is
   * written. For Claude on first-party routes, request the model's output
   * limit instead. `max_tokens` is a ceiling, not a cache key, so this does
   * not invalidate prompt caching.
   *
   * The shared default stays in place when the user sets
   * KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX, for small requests, for other
   * providers, and when an explicit thinking budget is set (the SDK adds
   * that budget to `max_tokens` itself).
   */
  export function outputTokens(input: {
    model: Provider.Model
    options: Record<string, any>
    max: number | undefined
    small?: boolean
  }) {
    const base = ProviderTransform.maxOutputTokens(input.model, input.max)
    if (input.max !== undefined || input.small) return base
    if (!CLAUDE.has(input.model.api.npm)) return base
    if (!input.model.family?.toLowerCase().startsWith("claude") && !input.model.api.id.toLowerCase().includes("claude"))
      return base
    if (typeof input.options.thinking?.budgetTokens === "number") return base
    if (typeof input.options.reasoningConfig?.budgetTokens === "number") return base
    return Math.max(base, input.model.limit.output)
  }

  export function needsEstimate(input: { model: Provider.Model; configured: number | undefined }) {
    return input.configured !== undefined && input.configured > 0 && input.model.limit.context > 0
  }

  /**
   * Caps `maxOutputTokens` to fit within the model's context window after
   * accounting for the context the outgoing request will consume.
   *
   * Like opencode, the provider is the source of truth: when the last finished
   * turn reported usage, `reported` carries that provider-tokenized context size
   * (input + output + cache), which already accounts for image/vision input the
   * client cannot see. The client-side normalized estimate (encoded media and
   * opaque reasoning-state bytes excluded) is used as a floor so newly added
   * text or tool schemas still cap output, and as the sole basis on the first
   * turn before any usage is reported. The larger of the two is used so the cap
   * never under-counts.
   *
   * Many small models (e.g. qwen 7B, 32K context) ship with a default
   * max_output of 32K, leaving no room for input once tools are included.
   * This prevents the provider from rejecting the request with a context
   * overflow error.
   */
  export function capOutputTokens(input: {
    model: Provider.Model
    messages: ModelMessage[]
    tools: Record<string, { description?: string; inputSchema?: unknown }>
    configured: number | undefined
    usage?: ReturnType<typeof KiloSessionOverflow.measure>
    reported?: number
  }): number | undefined {
    if (input.configured == null) return input.configured
    if (input.configured <= 0) return undefined
    const { context } = input.model.limit
    if (!context) return input.configured

    const estimated =
      input.usage?.normalized ??
      KiloSessionOverflow.measure({ messages: input.messages, tools: input.tools }).normalized
    const tokens = Math.max(input.reported ?? 0, estimated)
    const available = context - tokens - SAFETY
    // If available is ≤0 the input alone exceeds context — return the original
    // value so the provider returns a natural overflow error which triggers
    // compaction (compactionAttempts guard stops the loop eventually).
    if (available <= 0) return input.configured
    if (available >= input.configured) return input.configured
    return Math.max(MIN_OUTPUT, available)
  }
}
