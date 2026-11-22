import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Usage } from "@opencode-ai/llm"
import type * as ModelsDev from "@opencode-ai/core/models-dev"
import { Provider } from "../../src/provider/provider"
import { Session as SessionNs } from "../../src/session/session"
import {
  CatalogProvider,
  OPENDESIGN_ID,
  OPENDESIGN_URL,
  OpenDesignAuthPlugin,
  OpenDesignResponse,
  listed,
  openDesignModel,
  opendesignURL,
  overlay,
} from "../../src/kilocode/provider/opendesign"

const saved = process.env.OPENDESIGN_BASE_URL

afterEach(() => {
  if (saved === undefined) delete process.env.OPENDESIGN_BASE_URL
  else process.env.OPENDESIGN_BASE_URL = saved
})

describe("opendesignURL", () => {
  const stored = { type: "api", metadata: { baseURL: "https://stored.test/v1" } }

  test("uses the URL saved by the Connect dialog when nothing else is set", () => {
    delete process.env.OPENDESIGN_BASE_URL
    expect(opendesignURL(undefined, stored)).toBe("https://stored.test/v1")
  })

  test("prefers env over the saved URL, and config over both", () => {
    process.env.OPENDESIGN_BASE_URL = "https://env.test/v1"
    expect(opendesignURL(undefined, stored)).toBe("https://env.test/v1")
    expect(opendesignURL("https://config.test/v1", stored)).toBe("https://config.test/v1")
  })

  test("falls back to the default endpoint when nothing is configured", () => {
    delete process.env.OPENDESIGN_BASE_URL
    expect(OPENDESIGN_URL).toBe("https://amr-link.open-design.ai/v1")
    expect(opendesignURL(undefined, undefined)).toBe(OPENDESIGN_URL)
    expect(opendesignURL(undefined, { type: "oauth" })).toBe(OPENDESIGN_URL)
  })

  test("ignores empty values so they cannot hide the default", () => {
    delete process.env.OPENDESIGN_BASE_URL
    expect(opendesignURL("", { type: "api", metadata: { baseURL: "" } })).toBe(OPENDESIGN_URL)
    expect(opendesignURL("", stored)).toBe("https://stored.test/v1")
  })

  test("treats an empty OPENDESIGN_BASE_URL as unset", () => {
    process.env.OPENDESIGN_BASE_URL = ""
    expect(opendesignURL(undefined, undefined)).toBe(OPENDESIGN_URL)
    expect(opendesignURL(undefined, stored)).toBe("https://stored.test/v1")
  })
})

describe("provider list", () => {
  test("adds OpenDesign to a catalog that does not have it", () => {
    const base = { other: { id: "other", name: "Other", env: [], models: {} } }
    const out = overlay(base)
    expect(Object.keys(out)).toEqual(["other", OPENDESIGN_ID])
    expect(out[OPENDESIGN_ID]).toBe(CatalogProvider)
    expect(out[OPENDESIGN_ID]?.api).toBe(OPENDESIGN_URL)
  })

  test("keeps an existing OpenDesign catalog entry", () => {
    const existing = { id: OPENDESIGN_ID, name: "Custom", env: [], models: {} }
    expect(overlay({ [OPENDESIGN_ID]: existing })[OPENDESIGN_ID]).toBe(existing)
  })

  test("only exempts OpenDesign from the empty-provider filter", () => {
    expect(listed(OPENDESIGN_ID)).toBe(true)
    expect(listed("apertis")).toBe(false)
  })
})

describe("OpenDesignAuthPlugin", () => {
  test("asks for the base URL alongside the API key", async () => {
    delete process.env.OPENDESIGN_BASE_URL
    const hooks = await OpenDesignAuthPlugin()
    expect(hooks.auth?.provider).toBe(OPENDESIGN_ID)
    const method = hooks.auth?.methods.at(0)
    expect(method?.type).toBe("api")
    expect(method?.prompts?.map((prompt) => prompt.key)).toEqual(["baseURL"])
    expect(method?.prompts?.at(0)).toMatchObject({ type: "text", placeholder: OPENDESIGN_URL })
  })

  test("skips the base URL prompt when OPENDESIGN_BASE_URL is set", async () => {
    process.env.OPENDESIGN_BASE_URL = "https://env.test/v1"
    const hooks = await OpenDesignAuthPlugin()
    expect(hooks.auth?.methods.at(0)?.prompts).toEqual([])
  })

  test("still asks for the base URL when OPENDESIGN_BASE_URL is empty", async () => {
    process.env.OPENDESIGN_BASE_URL = ""
    const hooks = await OpenDesignAuthPlugin()
    expect(hooks.auth?.methods.at(0)?.prompts?.map((prompt) => prompt.key)).toEqual(["baseURL"])
  })
})

describe("OpenDesign model list", () => {
  const decode = Schema.decodeUnknownSync(OpenDesignResponse)
  const list =
    decode({
      object: "list",
      data: [
        {
          id: "deepseek-v4-flash",
          object: "model",
          owned_by: "vela",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          metadata: { cost: "medium", context_limit: 1048000, context_budget: 232000, output_budget: 32000 },
          default: false,
          enabled: true,
        },
        {
          id: "deepseek-v4-flash-vision-exp",
          owned_by: "vela",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          metadata: { context_limit: 1048000, context_budget: 232000, output_budget: 32000 },
        },
        {
          id: "claude-haiku-5.5",
          owned_by: "vela",
          architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
          metadata: { context_limit: 1000000, context_budget: 228000, output_budget: 128000 },
        },
        {
          id: "minimax-m3.1-flash",
          owned_by: "vela",
          architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
          metadata: { context_limit: 1000000 },
        },
        {
          id: "av-only",
          owned_by: "vela",
          architecture: { input_modalities: ["text", "audio", "video"], output_modalities: ["text"] },
          metadata: { context_limit: 1048000, context_budget: 232000, output_budget: 32000 },
        },
        {
          id: "sparse",
          owned_by: null,
          architecture: null,
          metadata: { context_limit: 500000, context_budget: null, output_budget: null },
        },
        {
          id: "budget-only",
          metadata: { context_budget: 300000, output_budget: 64000 },
        },
        { id: "bare" },
      ],
    }).data ?? []
  const models = Object.fromEntries(list.map((item) => [item.id, openDesignModel(item)]))

  test("prefers the full context window over the gateway budget", () => {
    expect(models["deepseek-v4-flash"]?.limit).toEqual({ context: 1048000, output: 32000 })
    expect(models["claude-haiku-5.5"]?.limit).toEqual({ context: 1000000, output: 128000 })
  })

  test("uses the reported context limit when no budget is present", () => {
    expect(models["minimax-m3.1-flash"]?.limit).toEqual({ context: 1000000, output: 0 })
  })

  test("falls back to the gateway budget when the context limit is missing", () => {
    expect(models["budget-only"]?.limit).toEqual({ context: 300000, output: 64000 })
  })

  test("keeps the old context and leaves output to the default cap for bare entries", () => {
    expect(models["bare"]?.limit).toEqual({ context: 128000, output: 0 })
    expect(models["bare"]?.modalities).toEqual({ input: ["text"], output: ["text"] })
    expect(models["bare"]?.attachment).toBe(false)
  })

  test("prices models from the public catalog in dollars per million tokens", () => {
    expect(models["deepseek-v4-flash"]?.cost).toEqual({ input: 0.44, output: 1.32, cache_read: 0.028 })
    expect(models["minimax-m3.1-flash"]?.cost).toEqual({ input: 0.15, output: 0.6, cache_read: 0.015 })
  })

  test("applies context tiers for models priced by input size", () => {
    expect(models["claude-haiku-5.5"]?.cost).toEqual({
      input: 0.1,
      output: 0.5,
      cache_read: 0.01,
      cache_write: 0.125,
      tiers: [
        {
          input: 0.5,
          output: 2.5,
          cache_read: 0.05,
          cache_write: 0.625,
          tier: { type: "context", size: 100000 },
        },
      ],
    })
    expect(openDesignModel({ id: "gpt-6-luna" }).cost).toEqual({
      input: 0.1,
      output: 0.5,
      cache_read: 0.01,
      cache_write: 0.125,
      tiers: [
        {
          input: 0.2,
          output: 0.75,
          cache_read: 0.02,
          cache_write: 0.25,
          tier: { type: "context", size: 272000 },
        },
      ],
    })
  })

  test("keeps unknown models free instead of guessing a price", () => {
    expect(models["bare"]?.cost).toEqual({ input: 0, output: 0 })
  })

  test("uses a numeric cost reported by the gateway", () => {
    const model = openDesignModel({
      id: "deepseek-v4.1-flash",
      cost: {
        input: 9,
        output: 10,
        cache_read: 1,
        cache_write: 2,
        tiers: [
          {
            input: 20,
            output: 30,
            cache_read: 3,
            cache_write: 4,
            tier: { type: "context", size: 100000 },
          },
        ],
      },
    })
    expect(model.cost).toEqual({
      input: 9,
      output: 10,
      cache_read: 1,
      cache_write: 2,
      tiers: [
        {
          input: 20,
          output: 30,
          cache_read: 3,
          cache_write: 4,
          tier: { type: "context", size: 100000 },
        },
      ],
    })
  })

  test("keeps a flat gateway price flat instead of applying table tiers", () => {
    expect(openDesignModel({ id: "claude-haiku-5.5", cost: { input: 9, output: 10 } }).cost).toEqual({
      input: 9,
      output: 10,
      cache_read: 0.01,
      cache_write: 0.125,
    })
  })

  test("fills null gateway cache rates from the table", () => {
    expect(
      openDesignModel({
        id: "claude-haiku-5.5",
        cost: { input: 9, output: 10, cache_read: null, cache_write: null },
      }).cost,
    ).toEqual({ input: 9, output: 10, cache_read: 0.01, cache_write: 0.125 })
    expect(
      openDesignModel({ id: "deepseek-v4-flash", cost: { input: 9, output: 10, cache_read: null } }).cost,
    ).toEqual({ input: 9, output: 10, cache_read: 0.028 })
  })

  test("drops gateway tiers that are not usable context tiers", () => {
    expect(
      openDesignModel({
        id: "deepseek-v4.1-flash",
        cost: {
          input: 9,
          output: 10,
          tiers: [
            { input: 20, output: 30, tier: { type: "prompt", size: 1000 } },
            { input: null, output: 30, tier: { type: "context", size: 2000 } },
            { output: 30, tier: { type: "context", size: 3000 } },
            { input: 20, output: 30, cache_read: 1, tier: { type: "context", size: 4000 } },
          ],
        },
      }).cost,
    ).toEqual({
      input: 9,
      output: 10,
      cache_read: 0.006,
      tiers: [{ input: 20, output: 30, cache_read: 1, tier: { type: "context", size: 4000 } }],
    })
  })

  test("falls back to the table when the gateway cost is partial", () => {
    expect(openDesignModel({ id: "deepseek-v4.1-flash", cost: { input: 9 } }).cost).toEqual({
      input: 0.3,
      output: 1.2,
      cache_read: 0.006,
    })
  })

  test("maps gateway modalities and enables attachments for non-text input", () => {
    expect(models["deepseek-v4-flash"]?.modalities?.input).toEqual(["text"])
    expect(models["deepseek-v4-flash"]?.attachment).toBe(false)
    expect(models["deepseek-v4-flash-vision-exp"]?.modalities?.input).toEqual(["text", "image"])
    expect(models["deepseek-v4-flash-vision-exp"]?.attachment).toBe(true)
    expect(models["claude-haiku-5.5"]?.modalities?.input).toEqual(["text", "image", "pdf"])
    expect(models["minimax-m3.1-flash"]?.modalities?.input).toEqual(["text", "image"])
  })

  test("drops audio and video input the openai-compatible SDK cannot send", () => {
    expect(models["av-only"]?.modalities?.input).toEqual(["text"])
    expect(models["av-only"]?.attachment).toBe(false)
  })

  test("accepts null fields instead of rejecting the whole list", () => {
    expect(models["sparse"]?.family).toBe("")
    expect(models["sparse"]?.limit).toEqual({ context: 500000, output: 0 })
    expect(models["sparse"]?.modalities).toEqual({ input: ["text"], output: ["text"] })
  })
})

describe("OpenDesign model cost wiring", () => {
  const provider = Provider.fromModelsDevProvider({
    id: OPENDESIGN_ID,
    name: "OpenDesign",
    env: [],
    api: OPENDESIGN_URL,
    npm: "@ai-sdk/openai-compatible",
    models: {
      "deepseek-v4.1-flash": openDesignModel({ id: "deepseek-v4.1-flash" }),
      "claude-haiku-5.5": openDesignModel({ id: "claude-haiku-5.5" }),
    },
  } as unknown as ModelsDev.Provider)

  const get = (id: string, inputTokens: number, outputTokens: number) =>
    SessionNs.getUsage({
      model: provider.models[id],
      provider: { id: OPENDESIGN_ID } as Provider.Info,
      usage: new Usage({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }),
    })

  test("calculates deepseek cost from the wired provider model", () => {
    expect(get("deepseek-v4.1-flash", 1_000_000, 100_000).cost).toBeCloseTo(0.42, 10)
  })

  test("uses the claude context tier when calculating session cost", () => {
    expect(get("claude-haiku-5.5", 1_000_000, 100_000).cost).toBeCloseTo(0.75, 10)
  })

  test("uses the claude base rates below the context tier threshold", () => {
    expect(get("claude-haiku-5.5", 50_000, 10_000).cost).toBeCloseTo(0.01, 10)
  })
})

describe("real gateway payload", () => {
  test("covers every model in the gateway response with catalog pricing", async () => {
    const raw = await Bun.file(new URL("./fixtures/opendesign-models.json", import.meta.url)).json()
    const data = Schema.decodeUnknownSync(OpenDesignResponse)(raw).data ?? []
    const models = Object.fromEntries(data.map((item) => [item.id, openDesignModel(item)]))

    expect(data).toHaveLength(14)
    expect(models["deepseek-v4.1-flash"]?.cost).toEqual({ input: 0.3, output: 1.2, cache_read: 0.006 })
    expect(models["claude-haiku-5.5"]?.cost?.tiers).toHaveLength(1)
    expect(Object.values(models).every((model) => (model.cost?.input ?? 0) !== 0)).toBe(true)
    expect(models["bare"]).toBeUndefined()
  })
})

describe("OpenDesign reasoning", () => {
  const efforts = ["none", "low", "medium", "high", "xhigh", "max"]

  test("advertises every gateway model as reasoning-capable with effort levels from none to max", () => {
    const model = openDesignModel({ id: "deepseek-v4.1-flash" })
    expect(model.reasoning).toBe(true)
    expect(model.reasoning_options).toEqual([{ type: "effort", values: efforts }])
  })

  test("keeps only the effort levels the gateway model accepts", () => {
    expect(openDesignModel({ id: "glm-5.3-flashx" }).reasoning_options).toEqual([
      { type: "effort", values: ["none", "low", "high", "xhigh", "max"] },
    ])
    expect(openDesignModel({ id: "kimi-k2.7-code" }).reasoning_options).toEqual([
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
    ])
    expect(openDesignModel({ id: "minimax-m3.1-flash" }).reasoning_options).toEqual([
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ])
  })

  test("turns the advertised efforts into selectable reasoning variants", () => {
    const provider = {
      id: OPENDESIGN_ID,
      name: "OpenDesign",
      env: [],
      api: OPENDESIGN_URL,
      npm: "@ai-sdk/openai-compatible",
      models: {
        "deepseek-v4.1-flash": openDesignModel({ id: "deepseek-v4.1-flash" }),
        "glm-5.3-flashx": openDesignModel({ id: "glm-5.3-flashx" }),
      },
    } as unknown as ModelsDev.Provider

    const models = Provider.fromModelsDevProvider(provider).models
    expect(Object.keys(models["deepseek-v4.1-flash"]?.variants ?? {})).toEqual(efforts)
    expect(models["deepseek-v4.1-flash"]?.variants?.["max"]).toEqual({ reasoningEffort: "max" })
    expect(Object.keys(models["glm-5.3-flashx"]?.variants ?? {})).toEqual(["none", "low", "high", "xhigh", "max"])
  })
})
