import { afterAll, afterEach, describe, expect, it, mock } from "bun:test"
import { EventEmitter } from "node:events"
import * as fs from "node:fs/promises"

import * as processUtil from "../../src/util/process"

type ExecArgs = Parameters<typeof processUtil.exec>
type SpawnArgs = Parameters<typeof processUtil.spawn>

// Capture real implementations BEFORE mock.module registers: the namespace is
// live, so delegating through it after registration would recurse into the mock.
const realExec = processUtil.exec
const realSpawn = processUtil.spawn
const realUnlink = fs.unlink

let intercepting = false

const calls: string[][] = []
const platform = Object.getOwnPropertyDescriptor(process, "platform")
const ffmpeg = process.env.KILO_FFMPEG_PATH
const device = process.env.KILO_FFMPEG_AUDIO_DEVICE

Object.defineProperty(process, "platform", { value: "win32", configurable: true })
process.env.KILO_FFMPEG_PATH = "fake-ffmpeg"
delete process.env.KILO_FFMPEG_AUDIO_DEVICE

// Delegate to the real module unless intercepting: this mock is process-global
// in bun and other test files import the same module concurrently.
mock.module("../../src/util/process", () => ({
  ...processUtil,
  exec: async (bin: ExecArgs[0], args: ExecArgs[1], options?: ExecArgs[2]) => {
    if (!intercepting) return realExec(bin, args, options)
    calls.push(args as string[])
    if ((args as string[])[0] === "-list_devices") {
      return { stdout: "", stderr: '[dshow] DirectShow audio devices\n[dshow]  "Microphone" (audio)' }
    }
    return { stdout: "ffmpeg version", stderr: "" }
  },
  spawn: (...args: SpawnArgs) => {
    if (!intercepting) return realSpawn(...args)
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
    return proc as ReturnType<typeof processUtil.spawn>
  },
}))

mock.module("fs/promises", () => ({
  ...fs,
  unlink: async (...args: Parameters<typeof fs.unlink>) => {
    if (!intercepting) return realUnlink(...args)
  },
}))

const { cancelSpeechCapture, prewarmSpeechCapture, startSpeechCapture } = await import(
  "../../src/speech-to-text/capture"
)

afterAll(() => {
  intercepting = false
  mock.module("../../src/util/process", () => ({ ...processUtil, exec: realExec, spawn: realSpawn }))
  mock.module("fs/promises", () => ({ ...fs, unlink: realUnlink }))

  if (platform) Object.defineProperty(process, "platform", platform)
  if (ffmpeg === undefined) delete process.env.KILO_FFMPEG_PATH
  else process.env.KILO_FFMPEG_PATH = ffmpeg
  if (device === undefined) delete process.env.KILO_FFMPEG_AUDIO_DEVICE
  else process.env.KILO_FFMPEG_AUDIO_DEVICE = device
})

describe("speech capture prewarm", () => {
  afterEach(() => {
    intercepting = false
  })

  it("shares Windows DirectShow discovery across prewarm and capture start", async () => {
    intercepting = true

    await Promise.all([prewarmSpeechCapture(), prewarmSpeechCapture()])
    await startSpeechCapture({ requestId: "request", model: "model" })
    await cancelSpeechCapture("request")

    expect(calls.filter((args) => args[0] === "-version")).toHaveLength(1)
    expect(calls.filter((args) => args[0] === "-list_devices")).toHaveLength(1)
  })
})
