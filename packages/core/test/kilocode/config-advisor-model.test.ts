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
})
