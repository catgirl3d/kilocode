import { afterAll, describe, expect, it } from "bun:test"
import {
  cancelWasapiCapture,
  startWasapiCapture,
  stopWasapiCapture,
  wavFromChunks,
} from "../../src/speech-to-text/wasapi-capture"

describe("wavFromChunks", () => {
  it("writes a 16 kHz mono PCM RIFF header around concatenated payload", () => {
    const pcm = [Buffer.from([1, 2]), Buffer.from([3, 4, 5])]
    const wav = wavFromChunks(pcm)

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(wav.readUInt32LE(4)).toBe(36 + 5)
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE")
    expect(wav.readUInt32LE(16)).toBe(16)
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt32LE(28)).toBe(32000)
    expect(wav.readUInt16LE(32)).toBe(2)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data")
    expect(wav.readUInt32LE(40)).toBe(5)
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5])
  })

  it("keeps a header-only buffer when no audio arrived", () => {
    const wav = wavFromChunks([])

    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
  })
})

type Callback = (err: Error | null, chunk: Buffer | null) => void

class FakeMic {
  static hook: ((mic: FakeMic, cb: Callback) => void) | undefined
  private cb: Callback | undefined
  private stopped = false

  constructor(_opts: { sampleRate: number; channels: number; framesPerBuffer: number }) {}

  start(cb: Callback) {
    this.cb = cb
    if (FakeMic.hook) return FakeMic.hook(this, cb)
    setTimeout(() => cb(null, Buffer.from("pcm-payload")), 5)
  }

  stop() {
    if (!this.cb || this.stopped) return
    this.stopped = true
  }
}

afterAll(() => {
  FakeMic.hook = undefined
})

describe("wasapi capture flow", () => {
  it("starts once audio flows and stops into a base64 wav", async () => {
    expect(await startWasapiCapture({ requestId: "r1", model: "m" }, FakeMic)).toBe(true)

    const audio = await stopWasapiCapture("r1")
    expect(audio?.format).toBe("wav")
    const wav = Buffer.from(audio!.data, "base64")
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(wav.subarray(44).toString("ascii")).toBe("pcm-payload")

    expect(await startWasapiCapture({ requestId: "r2", model: "m" }, FakeMic)).toBe(true)
    expect(await cancelWasapiCapture("r2")).toBe(true)
    expect(await stopWasapiCapture("r2")).toBeUndefined()
  }, 20000)

  it("reports an unusable binding as unhandled so callers fall back", async () => {
    FakeMic.hook = (_mic, cb) => cb(new Error("device gone"), null)

    try {
      expect(await startWasapiCapture({ requestId: "r3", model: "m" }, FakeMic)).toBe(false)
      expect(await stopWasapiCapture("r3")).toBeUndefined()
    } finally {
      FakeMic.hook = undefined
    }
  }, 20000)

  it("stops collecting when the prompt audio limit is reached", async () => {
    FakeMic.hook = (_mic, cb) => {
      cb(null, Buffer.from("start"))
      setTimeout(() => cb(null, Buffer.alloc(5 * 1024 * 1024)), 5)
    }

    try {
      expect(await startWasapiCapture({ requestId: "r4", model: "m" }, FakeMic)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const err = await stopWasapiCapture("r4").then(
        () => undefined,
        (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
      )
      expect(err?.message).toBe("Voice input recording is limited to 5 MiB")
    } finally {
      FakeMic.hook = undefined
    }
  }, 20000)
})
