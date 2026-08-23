import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("advisor model configuration", () => {
  test("accepts advisor_model in V1 and V2 configuration", () => {
    const input = { experimental: { advisor_model: "openrouter/anthropic/claude-sonnet-4" } }

    expect(Schema.decodeUnknownSync(ConfigV1.Info)(input).experimental?.advisor_model).toBe(input.experimental.advisor_model)
    expect(Schema.decodeUnknownSync(Config.Info)(input).experimental?.advisor_model).toBe(input.experimental.advisor_model)
  })

  test("rejects non-string advisor_model values", () => {
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ experimental: { advisor_model: false } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { advisor_model: false } })).toThrow()
  })

  test("preserves advisor_model when migrating V1 configuration", () => {
    const migrated = ConfigMigrateV1.migrate({ experimental: { advisor_model: "openrouter/anthropic/claude-sonnet-4" } })

    expect(migrated.experimental?.advisor_model).toBe("openrouter/anthropic/claude-sonnet-4")
    expect(Schema.decodeUnknownSync(Config.Info)(migrated).experimental?.advisor_model).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    )
  })
})
