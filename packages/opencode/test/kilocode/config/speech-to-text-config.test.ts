import { describe, expect, test } from "bun:test"
import { Config } from "../../../src/config/config"
import { Schema } from "effect"

describe("Config.Info experimental speech-to-text model", () => {
  test("parses the selected speech-to-text model", () => {
    const parsed = Schema.decodeUnknownSync(Config.Info)({
      experimental: {
        speech_to_text_model: "openai/gpt-4o-mini-transcribe",
      },
    })

    expect(parsed.experimental?.speech_to_text_model).toBe("openai/gpt-4o-mini-transcribe")
  })

  test("keeps existing experimental defaults", () => {
    const parsed = Schema.decodeUnknownSync(Config.Info)({ experimental: { speech_to_text_model: "google/chirp-3" } })
    expect(parsed.experimental?.openTelemetry).toBe(true)
  })

  test("parses the selected speech-to-text output mode", () => {
    const parsed = Schema.decodeUnknownSync(Config.Info)({ experimental: { speech_to_text_mode: "translate" } })
    expect(parsed.experimental?.speech_to_text_mode).toBe("translate")
  })

  test("rejects unsupported speech-to-text output modes", () => {
    expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { speech_to_text_mode: "rewrite" } })).toThrow()
  })
})
