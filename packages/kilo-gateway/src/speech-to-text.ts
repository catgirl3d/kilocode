// fork_change - new file
export type SpeechToTextMode = "transcribe" | "translate"

const models: ReadonlyArray<{ id: string; label: string; modes: ReadonlyArray<SpeechToTextMode> }> = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large V3 Turbo", modes: ["transcribe"] },
  { id: "whisper-large-v3", label: "Whisper Large V3", modes: ["transcribe", "translate"] },
]

export const GROQ_TRANSCRIPTION_MODELS = models
export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
export const GROQ_TRANSLATIONS_URL = "https://api.groq.com/openai/v1/audio/translations"

export function resolveGroqTranscriptionModel(id: string): string | undefined {
  const model = id.startsWith("groq/") ? id.slice("groq/".length) : ""
  return GROQ_TRANSCRIPTION_MODELS.some((item) => item.id === model) ? model : undefined
}

export function supportsGroqSpeechToTextMode(id: string, mode: SpeechToTextMode): boolean {
  const model = id.startsWith("groq/") ? id.slice("groq/".length) : ""
  return GROQ_TRANSCRIPTION_MODELS.some((item) => item.id === model && item.modes.includes(mode))
}
