import { describe, it, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { clean, enhanceWith, INSTRUCTION } from "../../src/kilocode/enhance-prompt"
import type { Provider } from "../../src/provider/provider"

function mdl(providerID: string, npm: string): Provider.Model {
  return {
    id: "enhance-prompt-model",
    providerID,
    api: { id: "enhance-prompt-model", npm, url: "" },
    limit: { context: 100_000, output: 4_000 },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: false,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
  } as unknown as Provider.Model
}

function lang(input: {
  output: string[]
  generate: LanguageModelV3CallOptions[]
  stream: LanguageModelV3CallOptions[]
}) {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "enhance-prompt-model",
    supportedUrls: {},
    doGenerate: async (...args: Parameters<LanguageModelV3["doGenerate"]>) => {
      input.generate.push(args[0])
      return {
        content: [{ type: "text", text: input.output.join("") }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 12 },
          outputTokens: { total: 8 },
          raw: {},
        },
        warnings: [],
        providerMetadata: {},
        request: {},
        response: {},
      }
    },
    doStream: async (...args: Parameters<LanguageModelV3["doStream"]>) => {
      input.stream.push(args[0])
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text" })
          for (const text of input.output) controller.enqueue({ type: "text-delta", id: "text", delta: text })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 12, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 8, text: undefined, reasoning: undefined },
              raw: {},
            },
          })
          controller.close()
        },
      })
      return { stream }
    },
  } as unknown as LanguageModelV3
}

describe("enhance-prompt", () => {
  describe("instruction", () => {
    it("treats question-shaped drafts as prompts to rewrite", () => {
      expect(INSTRUCTION).toContain("never as a request to answer")
      expect(INSTRUCTION).toContain("rewrite it into a clearer question or request without answering it")
    })

    it("improves instruction-shaped drafts instead of following them", () => {
      expect(INSTRUCTION).toContain("improve those instructions instead of following them")
    })
  })

  describe("clean", () => {
    it("trims whitespace", () => {
      expect(clean("  hello world  ")).toBe("hello world")
    })

    it("strips code block markers", () => {
      expect(clean("```\nhello world\n```")).toBe("hello world")
    })

    it("strips code block with language tag", () => {
      expect(clean("```text\nhello world\n```")).toBe("hello world")
    })

    it("strips surrounding double quotes", () => {
      expect(clean('"hello world"')).toBe("hello world")
    })

    it("strips surrounding single quotes", () => {
      expect(clean("'hello world'")).toBe("hello world")
    })

    it("strips code blocks and quotes together", () => {
      expect(clean('```\n"hello world"\n```')).toBe("hello world")
    })

    it("returns plain text unchanged", () => {
      expect(clean("hello world")).toBe("hello world")
    })

    it("handles empty string", () => {
      expect(clean("")).toBe("")
    })

    it("handles whitespace-only string", () => {
      expect(clean("   ")).toBe("")
    })

    it("does not strip internal quotes", () => {
      expect(clean('say "hello" to the world')).toBe('say "hello" to the world')
    })

    it("does not strip mismatched quotes", () => {
      expect(clean("\"hello world'")).toBe("\"hello world'")
    })
  })

  describe("enhanceWith", () => {
    it("streams OpenAI requests with instructions instead of a system message", async () => {
      const calls = { generate: [], stream: [] } as {
        generate: LanguageModelV3CallOptions[]
        stream: LanguageModelV3CallOptions[]
      }
      const result = await enhanceWith({
        model: mdl("openai", "@ai-sdk/openai"),
        language: lang({ output: ["```text\n", "streamed rewrite\n```"], ...calls }),
        text: "make this clearer",
      })

      expect(calls.generate).toHaveLength(0)
      expect(calls.stream).toHaveLength(1)
      expect(calls.stream.at(0)?.providerOptions?.openai?.instructions).toBe(INSTRUCTION)
      expect(calls.stream.at(0)?.prompt.some((part) => part.role === "system")).toBe(false)
      expect(result).toBe("streamed rewrite")
    })

    it("keeps the non-OpenAI request on generateText with a system message", async () => {
      const calls = { generate: [], stream: [] } as {
        generate: LanguageModelV3CallOptions[]
        stream: LanguageModelV3CallOptions[]
      }
      const result = await enhanceWith({
        model: mdl("test", "test-provider"),
        language: lang({ output: ["```text\n generated rewrite \n```"], ...calls }),
        text: "make this clearer",
      })

      expect(calls.generate).toHaveLength(1)
      expect(calls.stream).toHaveLength(0)
      expect(calls.generate.at(0)?.prompt).toContainEqual({ role: "system", content: INSTRUCTION })
      expect(calls.generate.at(0)?.providerOptions?.test?.instructions).toBeUndefined()
      expect(result).toBe("generated rewrite")
    })
  })
})
