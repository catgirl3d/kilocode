import { GROQ_TRANSCRIPTION_MODELS, type SpeechToTextMode } from "@kilocode/kilo-gateway/speech-to-text"

export type { SpeechToTextMode }

export interface SpeechToTextModelDef {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly providerID: "kilo" | "groq"
  readonly modes?: readonly SpeechToTextMode[]
  readonly verbatim?: boolean
}

const models: SpeechToTextModelDef[] = [
  {
    id: "nvidia/parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3",
    provider: "NVIDIA",
    providerID: "kilo",
  },
  {
    id: "openai/whisper-large-v3-turbo",
    label: "Whisper Large V3 Turbo",
    provider: "OpenAI-compatible",
    providerID: "kilo",
  },
  {
    id: "openai/gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    provider: "OpenAI",
    providerID: "kilo",
    verbatim: true,
  },
  {
    id: "openai/gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    provider: "OpenAI",
    providerID: "kilo",
    verbatim: true,
  },
  {
    id: "openai/whisper-1",
    label: "Whisper 1",
    provider: "OpenAI",
    providerID: "kilo",
  },
  {
    id: "openai/whisper-large-v3",
    label: "Whisper Large V3",
    provider: "OpenAI-compatible",
    providerID: "kilo",
  },
  {
    id: "google/chirp-3",
    label: "Chirp 3",
    provider: "Google",
    providerID: "kilo",
  },
  ...GROQ_TRANSCRIPTION_MODELS.map((model) => ({
    id: `groq/${model.id}`,
    label: model.label,
    provider: "Groq",
    providerID: "groq" as const,
    modes: model.modes,
  })),
]

export const SPEECH_TO_TEXT_MODELS: readonly SpeechToTextModelDef[] = models
export const DEFAULT_SPEECH_TO_TEXT_MODEL: SpeechToTextModelDef = models[0]!

export function mergeSpeechToTextModels(models: readonly SpeechToTextModelDef[]): SpeechToTextModelDef[] {
  const ids = new Set(models.map((model) => model.id))
  return [...models, ...SPEECH_TO_TEXT_MODELS.filter((model) => model.providerID === "groq" && !ids.has(model.id))]
}

export function getSpeechToTextModel(id: string | undefined): SpeechToTextModelDef {
  for (const model of models) {
    if (model.id === id) return model
  }
  return DEFAULT_SPEECH_TO_TEXT_MODEL
}
