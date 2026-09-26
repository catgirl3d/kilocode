import { describe, expect, it } from "bun:test"
import { ProcessTree } from "@/kilocode/background-process/process-tree"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import { rm } from "fs/promises"

describe("ProcessTree.snapshot", () => {
  it("serves a fresh cache entry without scanning", async () => {
    const rows = [{ pid: 1, parent: 0, birth: "b1" }]
    await Filesystem.write(ProcessTree.CACHE, JSON.stringify({ time: Date.now(), ok: true, rows }), 0o600)
    const step = await ProcessTree.snapshot(60_000)
    expect(step.scanned).toBe(false)
    expect(step.fresh).toBe(true)
    expect(step.snap.rows).toEqual(rows)
  })

  it("does not scan and returns not-fresh when the signal is already aborted", async () => {
    await rm(ProcessTree.CACHE, { force: true })
    const started = Date.now()
    const step = await ProcessTree.snapshot(0, AbortSignal.abort())
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(step.scanned).toBe(false)
    expect(step.fresh).toBe(false)
    expect(step.snap.ok).toBe(false)
  })

  it("waits out another runner's lock without scanning and stops when aborted", async () => {
    await rm(ProcessTree.CACHE, { force: true })
    const lease = await Flock.acquire("background-process:snapshot", { dir: ProcessTree.LOCKS, timeoutMs: 1_000 })
    try {
      const started = Date.now()
      const step = await ProcessTree.snapshot(0, AbortSignal.timeout(300))
      expect(Date.now() - started).toBeLessThan(1_500)
      expect(step.scanned).toBe(false)
      expect(step.fresh).toBe(false)
      expect(await Bun.file(ProcessTree.CACHE).exists()).toBe(false)
    } finally {
      await lease.release()
    }
  })

  it.skipIf(process.platform !== "win32")("publishes a real scan and serves it afterwards", async () => {
    await rm(ProcessTree.CACHE, { force: true })
    const first = await ProcessTree.snapshot(0)
    expect(first.scanned).toBe(true)
    expect(first.fresh).toBe(true)
    expect(first.snap.ok).toBe(true)
    expect(first.snap.rows.length).toBeGreaterThan(0)
    const second = await ProcessTree.snapshot(60_000)
    expect(second.scanned).toBe(false)
    expect(second.fresh).toBe(true)
    expect(second.snap.rows).toEqual(first.snap.rows)
  })
})
