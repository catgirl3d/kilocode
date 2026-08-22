// fork_change start
import { GROQ_TRANSCRIPTION_MODELS, type SpeechToTextMode } from "@kilocode/kilo-gateway/speech-to-text"

export type { SpeechToTextMode }

// fork_change end
export interface SpeechToTextModelDef {
  readonly id: string
  readonly label: string
  readonly provider: string
  // fork_change start
  readonly providerID: "kilo" | "groq"
  readonly modes?: readonly SpeechToTextMode[]
  // fork_change end
  readonly verbatim?: boolean
}

const models: SpeechToTextModelDef[] = [
  {
    id: "nvidia/parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3",
    provider: "NVIDIA",
    // fork_change start
    providerID: "kilo",
    // fork_change end
  },
  {
    id: "openai/whisper-large-v3-turbo",
    label: "Whisper Large V3 Turbo",
    provider: "OpenAI-compatible",
    // fork_change start
    providerID: "kilo",
    // fork_change end
  },
  {
    id: "openai/gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    provider: "OpenAI",
    // fork_change start
    providerID: "kilo",
    // fork_change end
    verbatim: true,
  },
  {
    id: "openai/gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    provider: "OpenAI",
    // fork_change start
    providerID: "kilo",
    // fork_change end
    verbatim: true,
  },
  {
    id: "openai/whisper-1",
    label: "Whisper 1",
    provider: "OpenAI",
    // fork_change start
    providerID: "kilo",
    // fork_change end
  },
  {
    id: "openai/whisper-large-v3",
    label: "Whisper Large V3",
    provider: "OpenAI-compatible",
    // fork_change start
    providerID: "kilo",
    // fork_change end
  },
  {
    id: "google/chirp-3",
    label: "Chirp 3",
    provider: "Google",
    // fork_change start
    providerID: "kilo",
    // fork_change end
  },
  // fork_change start
  ...GROQ_TRANSCRIPTION_MODELS.map((model) => ({
    id: `groq/${model.id}`,
    label: model.label,
    provider: "Groq",
    providerID: "groq" as const,
    modes: model.modes,
  })),
  // fork_change end
]

export const SPEECH_TO_TEXT_MODELS: readonly SpeechToTextModelDef[] = models
export const DEFAULT_SPEECH_TO_TEXT_MODEL: SpeechToTextModelDef = models[0]!

// fork_change start
export function mergeSpeechToTextModels(models: readonly SpeechToTextModelDef[]): SpeechToTextModelDef[] {
  const ids = new Set(models.map((model) => model.id))
  return [...models, ...SPEECH_TO_TEXT_MODELS.filter((model) => model.providerID === "groq" && !ids.has(model.id))]
}

// fork_change end
export function getSpeechToTextModel(id: string | undefined): SpeechToTextModelDef {
  for (const model of models) {
    if (model.id === id) return model
  }
  return DEFAULT_SPEECH_TO_TEXT_MODEL
}
