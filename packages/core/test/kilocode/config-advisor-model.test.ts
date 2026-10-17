import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("advisor model configuration", () => {
  test("accepts advisor model and variant in V1 and V2 configuration", () => {
    const input = {
      experimental: {
        advisor_model: "openrouter/anthropic/claude-sonnet-4",
        advisor_variant: "high",
      },
    }

    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).experimental?.advisor_model).toBe(input.experimental.advisor_model)
    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).experimental?.advisor_variant).toBe(input.experimental.advisor_variant)
    expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.advisor_model).toBe(input.experimental.advisor_model)
    expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.advisor_variant).toBe(input.experimental.advisor_variant)
  })

  test("rejects non-string advisor_model values", () => {
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ experimental: { advisor_model: false } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { advisor_model: false } })).toThrow()
  })

  test("rejects non-string advisor_variant values", () => {
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ experimental: { advisor_variant: false } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { advisor_variant: false } })).toThrow()
  })

  test("preserves advisor model and variant when migrating V1 configuration", () => {
    const migrated = ConfigMigrateV1.migrate({
      experimental: { advisor_model: "openrouter/anthropic/claude-sonnet-4", advisor_variant: "high" },
    })

    expect(migrated.experimental?.advisor_model).toBe("openrouter/anthropic/claude-sonnet-4")
    expect(migrated.experimental?.advisor_variant).toBe("high")
    expect(Schema.decodeUnknownSync(Config.Info)(migrated).experimental?.advisor_model).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    )
    expect(Schema.decodeUnknownSync(Config.Info)(migrated).experimental?.advisor_variant).toBe("high")
  })

  test("migrates an advisor variant without an advisor model", () => {
    expect(ConfigMigrateV1.migrate({ experimental: { advisor_variant: "high" } }).experimental?.advisor_variant).toBe("high")
  })

  const advisors = [
    {
      name: "security",
      description: "finds vulnerabilities",
      prompt: "Review for injection and secret leaks.",
      model: "openrouter/anthropic/claude-sonnet-4",
      variant: "high",
    },
    { name: "fast", model: "openrouter/openai/gpt-5-mini" },
  ]

  test("accepts advisor slots in V1 and V2 configuration", () => {
    const input = { experimental: { advisors } }

    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).experimental?.advisors).toEqual(advisors)
    expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.advisors).toEqual(advisors)
  })

  test("keeps slot content lenient so runtime normalization can skip bad entries", () => {
    const input = {
      experimental: {
        advisors: [
          { name: "Not A Valid Name", model: "" },
          { name: "long", model: "p/m", description: "d".repeat(500), prompt: "p".repeat(20_001) },
          { name: "a", model: "p/a" },
          { name: "b", model: "p/b" },
          { name: "a", model: "p/c" },
        ],
      },
    }

    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).experimental?.advisors).toHaveLength(5)
    expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.advisors).toHaveLength(5)
  })

  test("rejects advisor slots with wrong field types", () => {
    for (const advisors of [
      "security",
      [{ name: "security" }],
      [{ model: "p/m" }],
      [{ name: 1, model: "p/m" }],
      [{ name: "security", model: false }],
      [{ name: "security", model: "p/m", prompt: 3 }],
    ]) {
      expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ experimental: { advisors } })).toThrow()
      expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { advisors } })).toThrow()
    }
  })

  test("preserves advisor slots when migrating V1 configuration", () => {
    const migrated = ConfigMigrateV1.migrate({ experimental: { advisors } })

    expect(migrated.experimental?.advisors).toEqual(advisors)
    expect(Schema.decodeUnknownSync(Config.Info)(migrated).experimental?.advisors).toEqual(advisors)
  })
})
