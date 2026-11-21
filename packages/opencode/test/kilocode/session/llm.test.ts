import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { KiloLLM } from "@/kilocode/session/llm"

describe("kilocode.session.llm.timeout", () => {
  test("uses prepared options before the provider fallback", () => {
    const result = KiloLLM.timeout({
      options: { chunkTimeout: 15_000 },
      fallback: { chunkTimeout: 30_000 },
    })

    expect(result).toEqual({ timeout: { chunkMs: 15_000 } })
  })

  test("uses the provider fallback when prepared options omit the timeout", () => {
    const result = KiloLLM.timeout({
      options: {},
      fallback: { chunkTimeout: 30_000 },
    })

    expect(result).toEqual({ timeout: { chunkMs: 30_000 } })
  })

  test("uses the provider fallback when the prepared value is not a number", () => {
    const result = KiloLLM.timeout({
      options: { chunkTimeout: "15_000" },
      fallback: { chunkTimeout: 30_000 },
    })

    expect(result).toEqual({ timeout: { chunkMs: 30_000 } })
  })

  test("omits the timeout when it is not configured", () => {
    expect(KiloLLM.timeout({ options: {} })).toEqual({})
  })
})

describe("kilocode.session.llm.text", () => {
  test("joins text delta events", async () => {
    const out = await Effect.runPromise(
      KiloLLM.text(
        Stream.make(
          LLMEvent.textDelta({ id: "text", text: "hello " }),
          LLMEvent.textDelta({ id: "text", text: "world" }),
        ),
      ),
    )

    expect(out).toBe("hello world")
  })

  test("fails on stream errors after partial text", async () => {
    const err = new Error("provider unavailable")
    const text = KiloLLM.text(
      Stream.concat(Stream.make(LLMEvent.textDelta({ id: "text", text: "partial" })), Stream.fail(err)),
    )

    await expect(Effect.runPromise(text)).rejects.toThrow("provider unavailable")
  })

  test("fails on stream interruption", async () => {
    const text = KiloLLM.text(Stream.fail(new DOMException("Aborted", "AbortError")))

    await expect(Effect.runPromise(text)).rejects.toMatchObject({ name: "AbortError" })
  })
})

const KEY = "sk-test-1234567890abcdefghijklmnop"
const SYSTEM = `OPENAI_API_KEY="${KEY}"`

describe("kilocode.session.llm.redaction", () => {
  test("the personal policy is enabled unless the global config says false", () => {
    expect(KiloLLM.enabled(undefined)).toBe(true)
    expect(KiloLLM.enabled({})).toBe(true)
    expect(KiloLLM.enabled({ experimental: {} })).toBe(true)
    expect(KiloLLM.enabled({ experimental: { redact_secrets: true } })).toBe(true)
    expect(KiloLLM.enabled({ experimental: { redact_secrets: false } })).toBe(false)
  })

  test("scrubs system, text, tool-call and tool-result copies without mutating the input", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: [{ type: "text", text: `here is ${KEY}` }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: `using ${KEY}` },
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { api_key: KEY, command: "echo hi" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "json", value: { token: KEY, ok: true } },
          },
        ],
      },
    ]
    const before = JSON.stringify(messages)
    const output = KiloLLM.messages(messages, true)
    const rendered = JSON.stringify(output)

    expect(rendered).not.toContain(KEY)
    expect(rendered).toContain("[redacted]")
    expect(rendered).toContain("echo hi")
    expect(output[1]).not.toBe(messages[1])
    expect(JSON.stringify(messages)).toBe(before)
    expect(KiloLLM.system([SYSTEM], true)).toEqual([`OPENAI_API_KEY="[redacted]"`])
  })

  test("leaves clean messages and the disabled policy byte-identical", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "const token: string = login()" }] },
    ]
    expect(KiloLLM.messages(messages, false)).toBe(messages)
    expect(KiloLLM.messages(messages, true)).toEqual(messages)
    expect(KiloLLM.system(["You are helpful."], false)).toEqual(["You are helpful."])
  })

  test("scrubs unsigned reasoning but refuses to rewrite a signed block", () => {
    const unsigned = KiloLLM.messages(
      [{ role: "assistant", content: [{ type: "reasoning", text: `look ${KEY}` }] }],
      true,
    )
    expect(JSON.stringify(unsigned)).not.toContain(KEY)

    const clean = { role: "assistant", content: [{ type: "reasoning", text: "just thinking", providerOptions: { anthropic: { signature: "opaque" } } }] } as ModelMessage
    expect(KiloLLM.messages([clean], true)[0]).toEqual(clean)

    const dirty = {
      role: "assistant",
      content: [{ type: "reasoning", text: `look ${KEY}`, providerOptions: { anthropic: { signature: "opaque" } } }],
    } as ModelMessage
    expect(() => KiloLLM.messages([dirty], true)).toThrow(MemoryRedact.Failure)
  })

  test("keeps synthetic tool attachments in the same signed reasoning turn", () => {
    const state = { anthropic: { signature: "opaque" } }
    const input: ModelMessage[] = [
      { role: "user", content: "Read this file" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: `look ${KEY}`, providerOptions: state },
          { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "test.png" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-1", toolName: "read", output: { type: "text", value: "image" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }] },
    ]
    expect(() => KiloLLM.messages(input, true)).toThrow(MemoryRedact.Failure)

    const answer = { type: "text", text: "Read the file." } as const
    const next = KiloLLM.messages(
      [
        ...input,
        { role: "assistant", content: [{ type: "reasoning", text: "thinking", providerOptions: state }, answer] },
        { role: "user", content: "Next question" },
      ],
      true,
    )
    expect(next.at(-2)).toEqual({ role: "assistant", content: [answer] })
  })

  test("scrubs replayed reasoning text and summary in part provider options", () => {
    const details: Array<Record<string, string>> = [
      { type: "reasoning.text", text: `API_KEY=${KEY}` },
      { type: "reasoning.summary", summary: `API_KEY=${KEY}` },
    ]
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: details } } }],
      },
    ] as ModelMessage[]
    const output = KiloLLM.messages(messages, true)
    const content = output[0].content as Array<Record<string, any>>

    expect(content[0].providerOptions.openrouter.reasoning_details).toEqual([
      { type: "reasoning.text", text: "API_KEY=[redacted]" },
      { type: "reasoning.summary", summary: "API_KEY=[redacted]" },
    ])
    // The stored part keeps its original values.
    expect(details[0].text).toContain(KEY)
    expect(details[1].summary).toContain(KEY)
    expect(JSON.stringify(messages)).toContain(KEY)
  })

  test("scrubs replayed reasoning provider options on tool-call parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "echo hi" },
            providerOptions: {
              openrouter: { reasoning_details: [{ type: "reasoning.text", text: `API_KEY=${KEY}` }] },
            },
          },
        ],
      },
    ] as ModelMessage[]
    const output = KiloLLM.messages(messages, true)
    const part = (output[0].content as Array<Record<string, any>>)[0]

    expect(part.providerOptions.openrouter.reasoning_details).toEqual([
      { type: "reasoning.text", text: "API_KEY=[redacted]" },
    ])
    // The immutable tool-call contract stays intact.
    expect(part.input).toEqual({ command: "echo hi" })
  })

  test("refuses to rewrite a signed provider-options block with a key", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              anthropic: { signature: "opaque" },
              openrouter: { reasoning_details: [{ type: "reasoning.summary", summary: `API_KEY=${KEY}` }] },
            },
          },
        ],
      },
    ] as ModelMessage[]

    expect(() => KiloLLM.messages(messages, true)).toThrow(MemoryRedact.Failure)
  })

  test("throws instead of replacing a key in an immutable contract string", () => {
    const toolCall = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: KEY, toolName: "bash", input: {} }] },
    ] as ModelMessage[]
    expect(() => KiloLLM.messages(toolCall, true)).toThrow(MemoryRedact.Failure)

    const propertyKey = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { [KEY]: 1 } }] },
    ] as ModelMessage[]
    expect(() => KiloLLM.messages(propertyKey, true)).toThrow(MemoryRedact.Failure)
  })

  test("drops old signed message-level replay and same-turn signatures without dropping unsigned reasoning or calls", () => {
    const user = { role: "user", content: "Please continue" } satisfies ModelMessage
    const replay = { reasoning_details: [{ type: "reasoning.text", text: KEY, signature: "opaque" }] }
    const text = { type: "text", text: "Answer" } as const
    const call = { type: "tool-call", toolCallId: "call-1", toolName: "read", input: {} } as const
    const reasoning = { type: "reasoning", text: `look ${KEY}` } as const
    const signed = {
      type: "reasoning",
      text: "thinking",
      providerOptions: { anthropic: { signature: "later" } },
    } as const
    const opaque = { reasoning_details: [{ type: "reasoning.encrypted", data: "earlier" }] }
    const messages: ModelMessage[] = [
      user,
      { role: "assistant", content: [text], providerOptions: { openrouter: replay } },
      { role: "assistant", content: [reasoning, signed, { ...call, providerOptions: { openrouter: opaque } }] },
      user,
      { role: "assistant", content: [signed, text] },
    ]
    expect(KiloLLM.final({ messages, redact: true }).messages).toEqual([
      user,
      { role: "assistant", content: [text] },
      { role: "assistant", content: [{ ...reasoning, text: "look [redacted]" }, call] },
      user,
      { role: "assistant", content: [signed, text] },
    ])
    const invalid: ModelMessage = { role: "assistant", content: [{ ...call, toolCallId: KEY }] }
    expect(() => KiloLLM.final({ messages: [user, ...messages.slice(1, 3), invalid, user], redact: true })).toThrow(
      MemoryRedact.Failure,
    )
  })

  test("scrubs prompt text and known provider-option text in the final pass", () => {
    const result = KiloLLM.final({
      messages: [{ role: "user", content: `hello ${KEY}` }],
      providerOptions: {
        openai: { instructions: SYSTEM, apiKey: KEY, reasoningSummary: "auto" },
        anthropic: { signature: KEY },
      },
      redact: true,
    })
    expect(JSON.stringify(result.messages)).not.toContain(KEY)
    expect((result.providerOptions?.openai as Record<string, unknown>).instructions).not.toContain(KEY)
    // Auth and opaque provider state are not treated as prompt text.
    expect((result.providerOptions?.openai as Record<string, unknown>).apiKey).toBe(KEY)
    expect((result.providerOptions?.anthropic as Record<string, unknown>).signature).toBe(KEY)

    const clean = { messages: [{ role: "user", content: "hi" }] as ModelMessage[], providerOptions: { openai: { instructions: "be brief" } }, redact: true }
    expect(KiloLLM.final(clean).providerOptions).toEqual(clean.providerOptions)
  })
})
