import { describe, expect, it } from "bun:test"
import { slimProviders } from "../../src/provider-actions"

const model = {
  id: "m1",
  name: "Model One",
  api: "drop",
  headers: { authorization: "drop" },
  family: "drop",
  status: "beta",
  limit: { context: 1000, input: 900, output: 100 },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 }, tiers: [{ over: 200000 }] },
  capabilities: {
    reasoning: true,
    temperature: true,
    input: { text: true, image: true, audio: false, video: false, pdf: true },
  },
  variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
  options: { description: "fast", other: "drop" },
  autoRouting: { models: ["a"] },
  recommendedIndex: 2,
  isFree: false,
  mayTrainOnYourPrompts: true,
  hasUserByokAvailable: false,
  terminalBench: { overallScore: 3, avgAttemptCostUsd: 4, extra: 5 },
  release_date: "2026-01-01",
}

const provider = {
  id: "p",
  name: "Provider",
  source: "models.dev",
  env: ["KEY"],
  options: { apiKey: "drop" },
  description: "drop",
  metadata: { priority: 1, icon: "i", noteKey: "n", extra: "drop" },
  models: { m1: model },
}

describe("slimProviders", () => {
  it("keeps the fields the webview reads and drops catalog-heavy fields", () => {
    const [slim] = slimProviders([provider]) as unknown as Array<Record<string, unknown>>
    const models = slim!.models as Record<string, Record<string, unknown>>
    const next = models.m1!

    expect(slim).not.toHaveProperty("env")
    expect(slim).not.toHaveProperty("options")
    expect(slim).not.toHaveProperty("description")
    expect(slim!.metadata).toEqual({ priority: 1, icon: "i", noteKey: "n" })
    expect(next.id).toBe("m1")
    expect(next.name).toBe("Model One")
    expect(next.limit).toEqual({ context: 1000, output: 100 })
    expect(next.cost).toEqual({ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } })
    expect(next.variants).toEqual({ high: {}, low: {} })
    expect(next.capabilities).toEqual({
      reasoning: true,
      input: { text: true, image: true, audio: false, video: false, pdf: true },
    })
    expect(next.options).toEqual({ description: "fast" })
    expect(next.autoRouting).toEqual({ models: ["a"] })
    expect(next.terminalBench).toEqual({ overallScore: 3, avgAttemptCostUsd: 4 })
    expect(next.releaseDate).toBe("2026-01-01")
    for (const key of ["api", "headers", "family", "status", "release_date"]) {
      expect(next).not.toHaveProperty(key)
    }
  })
})
