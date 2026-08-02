import { describe, expect, it } from "bun:test"
import {
  canConfigureSpeechToText,
  canUseSpeechToText,
  canTranslateSpeechToText,
  selectedSpeechToTextModel,
  selectedSpeechToTextMode,
} from "../../webview-ui/src/components/speech-to-text/availability"
import { DEFAULT_SPEECH_TO_TEXT_MODEL } from "../../src/speech-to-text/models"

describe("speech-to-text availability", () => {
  it("shows speech input for stored Kilo credentials", () => {
    expect(canUseSpeechToText({}, { kilo: "oauth" })).toBe(true)
    expect(canUseSpeechToText({}, { kilo: "api" })).toBe(true)
  })

  it("hides speech input without usable Kilo credentials", () => {
    expect(canUseSpeechToText({}, {})).toBe(false)
    expect(canUseSpeechToText({}, { kilo: "wellknown" })).toBe(false)
  })

  it("shows direct Groq speech input only for an authenticated Groq model", () => {
    const config = { experimental: { speech_to_text_model: "groq/whisper-large-v3-turbo" } }

    expect(canUseSpeechToText(config, { groq: "api" })).toBe(true)
    expect(canUseSpeechToText(config, { groq: "oauth" })).toBe(false)
    expect(canUseSpeechToText(config, { kilo: "oauth" })).toBe(false)
  })

  it("honors enabled and disabled provider configuration", () => {
    expect(canUseSpeechToText({ disabled_providers: ["kilo"] }, { kilo: "oauth" })).toBe(false)
    expect(canUseSpeechToText({ enabled_providers: ["openai"] }, { kilo: "oauth" })).toBe(false)
    expect(canUseSpeechToText({ enabled_providers: ["kilo"] }, { kilo: "oauth" })).toBe(true)
  })

  it("honors Groq provider configuration", () => {
    const config = { experimental: { speech_to_text_model: "groq/whisper-large-v3" } }

    expect(canUseSpeechToText({ ...config, disabled_providers: ["groq"] }, { groq: "api" })).toBe(false)
    expect(canUseSpeechToText({ ...config, enabled_providers: ["kilo"] }, { groq: "api" })).toBe(false)
    expect(canUseSpeechToText({ ...config, enabled_providers: ["groq"] }, { groq: "api" })).toBe(true)
  })

  it("allows configuring Groq models without Kilo credentials", () => {
    expect(canConfigureSpeechToText({}, { groq: "api" })).toBe(true)
    expect(canConfigureSpeechToText({}, {})).toBe(false)
    expect(canConfigureSpeechToText({ disabled_providers: ["groq"] }, { groq: "api" })).toBe(false)
  })

  it("allows English translation only for Groq Whisper Large V3", () => {
    const v3 = { experimental: { speech_to_text_model: "groq/whisper-large-v3", speech_to_text_mode: "translate" } }
    const turbo = {
      experimental: { speech_to_text_model: "groq/whisper-large-v3-turbo", speech_to_text_mode: "translate" },
    }

    expect(canTranslateSpeechToText(v3)).toBe(true)
    expect(selectedSpeechToTextMode(v3)).toBe("translate")
    expect(canTranslateSpeechToText(turbo)).toBe(false)
    expect(selectedSpeechToTextMode(turbo)).toBe("transcribe")
  })

  it("normalizes configured and unknown transcription models", () => {
    expect(
      selectedSpeechToTextModel({ experimental: { speech_to_text_model: "google/chirp-3" } }, [
        { id: "google/chirp-3", label: "Chirp 3", provider: "Google" },
      ]),
    ).toBe("google/chirp-3")
    expect(selectedSpeechToTextModel({ experimental: { speech_to_text_model: "unknown/model" } })).toBe(
      DEFAULT_SPEECH_TO_TEXT_MODEL.id,
    )
  })
})
