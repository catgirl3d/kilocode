const models = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large V3 Turbo" },
  { id: "whisper-large-v3", label: "Whisper Large V3" },
] as const

export const GROQ_TRANSCRIPTION_MODELS = models
export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

export function resolveGroqTranscriptionModel(id: string): string | undefined {
  const model = id.startsWith("groq/") ? id.slice("groq/".length) : ""
  return GROQ_TRANSCRIPTION_MODELS.some((item) => item.id === model) ? model : undefined
}
