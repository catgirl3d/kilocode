import { afterAll, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"
import * as fs from "node:fs/promises"

const calls: string[][] = []
const platform = Object.getOwnPropertyDescriptor(process, "platform")
const ffmpeg = process.env.KILO_FFMPEG_PATH
const device = process.env.KILO_FFMPEG_AUDIO_DEVICE

Object.defineProperty(process, "platform", { value: "win32", configurable: true })
process.env.KILO_FFMPEG_PATH = "fake-ffmpeg"
delete process.env.KILO_FFMPEG_AUDIO_DEVICE

mock.module("../../src/util/process", () => ({
  exec: async (_bin: string, args: string[]) => {
    calls.push(args)
    if (args[0] === "-list_devices") {
      return { stdout: "", stderr: '[dshow] DirectShow audio devices\n[dshow]  "Microphone" (audio)' }
    }
    return { stdout: "ffmpeg version", stderr: "" }
  },
  spawn: () => {
    const proc = new EventEmitter()
    const stderr = new EventEmitter()
    Object.assign(proc, {
      exitCode: null,
      signalCode: null,
      killed: false,
      stderr,
      stdin: {
        writable: true,
        write: () => true,
        end: () => proc.emit("exit", 0, null),
      },
    })
    queueMicrotask(() => stderr.emit("data", Buffer.from("Output #0")))
    return proc as never
  },
}))

mock.module("fs/promises", () => ({ ...fs, unlink: async () => {} }))

const { cancelSpeechCapture, prewarmSpeechCapture, startSpeechCapture } = await import(
  "../../src/speech-to-text/capture"
)

afterAll(() => {
  if (platform) Object.defineProperty(process, "platform", platform)
  if (ffmpeg === undefined) delete process.env.KILO_FFMPEG_PATH
  else process.env.KILO_FFMPEG_PATH = ffmpeg
  if (device === undefined) delete process.env.KILO_FFMPEG_AUDIO_DEVICE
  else process.env.KILO_FFMPEG_AUDIO_DEVICE = device
})

describe("speech capture prewarm", () => {
  it("shares Windows DirectShow discovery across prewarm and capture start", async () => {
    await Promise.all([prewarmSpeechCapture(), prewarmSpeechCapture()])
    await startSpeechCapture({ requestId: "request", model: "model" })
    await cancelSpeechCapture("request")

    expect(calls.filter((args) => args[0] === "-version")).toHaveLength(1)
    expect(calls.filter((args) => args[0] === "-list_devices")).toHaveLength(1)
  })
})
