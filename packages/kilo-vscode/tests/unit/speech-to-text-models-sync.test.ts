import { describe, expect, it } from "bun:test"
import {
  DEFAULT_SPEECH_TO_TEXT_MODEL,
  mergeSpeechToTextModels,
  SPEECH_TO_TEXT_MODELS,
  getSpeechToTextModel,
} from "../../src/speech-to-text/models"

describe("speech-to-text model catalog", () => {
  it("uses NVIDIA Parakeet TDT 0.6B v3 as the fallback default", () => {
    expect(DEFAULT_SPEECH_TO_TEXT_MODEL.id).toBe("nvidia/parakeet-tdt-0.6b-v3")
    expect(DEFAULT_SPEECH_TO_TEXT_MODEL.id).toBe(SPEECH_TO_TEXT_MODELS[0]?.id)
  })

  it("falls back from unknown config model IDs", () => {
    expect(getSpeechToTextModel("unknown/model")).toBe(DEFAULT_SPEECH_TO_TEXT_MODEL)
  })

  it("includes NVIDIA Parakeet without prompt conditioning", () => {
    const model = getSpeechToTextModel("nvidia/parakeet-tdt-0.6b-v3")

    expect(model).toMatchObject({
      id: "nvidia/parakeet-tdt-0.6b-v3",
      label: "Parakeet TDT 0.6B v3",
      provider: "NVIDIA",
    })
    expect(model.verbatim).toBeUndefined()
  })

  it("includes direct Groq Whisper models", () => {
    expect(getSpeechToTextModel("groq/whisper-large-v3-turbo")).toMatchObject({
      id: "groq/whisper-large-v3-turbo",
      label: "Whisper Large V3 Turbo",
      provider: "Groq",
      providerID: "groq",
      modes: ["transcribe"],
    })
    expect(getSpeechToTextModel("groq/whisper-large-v3")).toMatchObject({
      id: "groq/whisper-large-v3",
      label: "Whisper Large V3",
      provider: "Groq",
      providerID: "groq",
      modes: ["transcribe", "translate"],
    })
  })

  it("keeps direct Groq models when the Kilo catalog refreshes", () => {
    const models = mergeSpeechToTextModels([
      {
        id: "fish-audio/transcribe-1",
        label: "Transcribe 1",
        provider: "Fish Audio",
        providerID: "kilo",
      },
    ])

    expect(models.map((model) => model.id)).toEqual([
      "fish-audio/transcribe-1",
      "groq/whisper-large-v3-turbo",
      "groq/whisper-large-v3",
    ])
  })
})
