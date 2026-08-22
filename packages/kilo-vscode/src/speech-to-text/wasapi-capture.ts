// fork_change - new file
import { existsSync } from "fs"
import * as path from "path"
import type { SpeechToTextMode } from "./models"

type ChunkCallback = (err: Error | null, chunk: Buffer | null) => void

type MicInstance = {
  start: (cb: ChunkCallback) => void
  stop: () => void
}

type MicBinding = {
  new (opts: { sampleRate: number; channels: number; framesPerBuffer: number }): MicInstance
}

type Input = {
  requestId: string
  model: string
  mode?: SpeechToTextMode
  language?: string
}

type Audio = {
  data: string
  format: "wav"
  model: string
  mode?: SpeechToTextMode
  language?: string
}

type Session = Input & {
  mic: MicInstance
  chunks: Buffer[]
  bytes: number
  stopped: boolean
  error?: Error
}

const SAMPLE_RATE = 16000
const FRAMES_PER_BUFFER = 1600
const START_TIMEOUT_MS = 5000
const FLUSH_MS = 30
const MAX_PCM_BYTES = 5 * 1024 * 1024

let active: Session | undefined

function loadMic(): MicBinding | undefined {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined
  const file = path.join(__dirname, "..", "bin", "kilo-mic-win32-x64.node")
  if (!existsSync(file)) return undefined
  try {
    const binding = require(file)
    return typeof binding?.MicStream === "function" ? binding.MicStream : undefined
  } catch (err) {
    console.warn("[Kilo New] WASAPI microphone binding failed to load", err)
    return undefined
  }
}

export function wavFromChunks(pcm: Buffer[], sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.concat(pcm)
  const wav = Buffer.alloc(44 + data.length)
  wav.write("RIFF", 0, "ascii")
  wav.writeUInt32LE(36 + data.length, 4)
  wav.write("WAVE", 8, "ascii")
  wav.write("fmt ", 12, "ascii")
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36, "ascii")
  wav.writeUInt32LE(data.length, 40)
  data.copy(wav, 44)
  return wav
}

function closeMic(session: Session): void {
  try {
    session.mic.stop()
  } catch (err) {
    console.warn("[Kilo New] Failed to stop WASAPI microphone", err)
  }
}

export async function startWasapiCapture(input: Input, Type = loadMic()): Promise<boolean> {
  const Mic = Type
  if (!Mic || active) return false

  const mic = new Mic({ sampleRate: SAMPLE_RATE, channels: 1, framesPerBuffer: FRAMES_PER_BUFFER })
  const session: Session = { ...input, mic, chunks: [], bytes: 0, stopped: false }

  let started = false
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      session.stopped = true
      closeMic(session)
      resolve(false)
    }, START_TIMEOUT_MS)
    const settle = (result: boolean) => {
      clearTimeout(timer)
      resolve(result)
    }
    mic.start((err, chunk) => {
      if (session.stopped) return
      if (err || !chunk || chunk.length === 0) {
        if (!started) {
          session.stopped = true
          settle(false)
          closeMic(session)
        }
        return
      }
      if (session.bytes + chunk.length > MAX_PCM_BYTES) {
        session.error = new Error("Voice input recording is limited to 5 MiB")
        session.stopped = true
        closeMic(session)
        return
      }
      session.bytes += chunk.length
      session.chunks.push(chunk)
      if (!started) {
        started = true
        settle(true)
      }
    })
  })

  if (session.stopped) {
    return false
  }
  if (!ok) return false
  active = session
  return true
}

export async function stopWasapiCapture(requestId: string): Promise<Audio | undefined> {
  const session = active
  if (!session || session.requestId !== requestId) return undefined
  session.stopped = true
  active = undefined

  session.mic.stop()
  await new Promise((resolve) => setTimeout(resolve, FLUSH_MS))

  if (session.error) throw session.error
  if (session.chunks.length === 0) throw new Error("No audio was recorded")
  return {
    data: wavFromChunks(session.chunks).toString("base64"),
    format: "wav",
    model: session.model,
    mode: session.mode,
    language: session.language,
  }
}

export async function cancelWasapiCapture(requestId: string): Promise<boolean> {
  const session = active
  if (!session || session.requestId !== requestId) return false
  session.stopped = true
  active = undefined
  closeMic(session)
  return true
}
