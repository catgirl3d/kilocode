import { describe, expect, it } from "bun:test"
import { ProcessTree } from "@/kilocode/background-process/process-tree"

const row = (pid: number, parent: number, birth = `b${pid}`): ProcessTree.Row => ({ pid, parent, birth })
const step = (ok: boolean, rows: ProcessTree.Row[] = []): ProcessTree.Step => ({
  snap: { time: 0, ok, rows },
  scanned: true,
  fresh: true,
})

describe("ProcessTree.descendants", () => {
  it("collects descendants from the root while active", () => {
    const snap = { time: 0, ok: true, rows: [row(10, 1), row(11, 10), row(12, 11)] }
    const seen = ProcessTree.descendants(10, new Map(), true, snap)
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([11, 12])
  })

  it("walks known descendants when the root is not anchored", () => {
    const snap = { time: 0, ok: true, rows: [row(10, 1), row(11, 10), row(12, 11)] }
    const seen = new Map([[11, "b11"]])
    expect([...ProcessTree.descendants(10, seen, false, snap).keys()].sort((a, b) => a - b)).toEqual([11, 12])
  })

  it("drops known processes whose birth no longer matches", () => {
    const snap = { time: 0, ok: true, rows: [row(11, 10, "new")] }
    const seen = new Map([
      [11, "old"],
      [12, "b12"],
    ])
    expect([...ProcessTree.descendants(10, seen, false, snap).keys()]).toEqual([])
  })

  it("keeps known processes untouched when the snapshot failed", () => {
    const seen = new Map([[11, "b11"]])
    expect(ProcessTree.descendants(10, seen, true, { time: 0, ok: false, rows: [] })).toBe(seen)
  })
})

describe("ProcessTree.pace", () => {
  it("resets failures and restores the base pause after a fresh snapshot", () => {
    expect(ProcessTree.pace({ grace: false, ok: true, scanned: true, fails: 4, delay: 500 })).toEqual({
      fails: 0,
      delay: ProcessTree.SCAN,
    })
    expect(ProcessTree.pace({ grace: true, ok: true, scanned: true, fails: 4, delay: 500 })).toEqual({
      fails: 0,
      delay: ProcessTree.WATCH,
    })
  })

  it("backs off after a failed scan", () => {
    expect(ProcessTree.pace({ grace: false, ok: false, scanned: true, fails: 1, delay: ProcessTree.SCAN })).toEqual({
      fails: 2,
      delay: ProcessTree.SCAN * 2,
    })
  })

  it("caps the backoff", () => {
    const paced = ProcessTree.pace({ grace: false, ok: false, scanned: true, fails: 3, delay: ProcessTree.BACKOFF })
    expect(paced.delay).toBe(ProcessTree.BACKOFF)
  })

  it("leaves state alone when the snapshot was served from cache", () => {
    expect(ProcessTree.pace({ grace: false, ok: false, scanned: false, fails: 2, delay: 700 })).toEqual({
      fails: 2,
      delay: 700,
    })
  })
})

describe("ProcessTree.targets", () => {
  it("includes the root only while it is safe", () => {
    const seen = new Map([[11, "b11"]])
    expect(ProcessTree.targets(10, seen, new Set(), true)).toEqual([10, 11])
    expect(ProcessTree.targets(10, seen, new Set(), false)).toEqual([11])
  })

  it("skips processes that were already killed", () => {
    const seen = new Map([
      [11, "b11"],
      [12, "b12"],
    ])
    expect(ProcessTree.targets(10, seen, new Set([10, 11]), true)).toEqual([12])
  })
})

describe("ProcessTree.track", () => {
  it("keeps running and never kills when enumeration keeps failing", async () => {
    const kills: number[][] = []
    const alerts: number[] = []
    let clock = 0
    let ticks = 0
    const hooks: ProcessTree.Hooks = {
      snapshot: async () => step(false),
      kill: async (items) => {
        kills.push([...items])
      },
      control: async () => false,
      clear: async () => {},
      sleep: async (ms) => {
        clock += ms
        ticks += 1
        if (ticks > 2_000) throw new Error("iteration limit")
      },
      now: () => clock,
      alert: (fails) => alerts.push(fails),
    }
    await expect(ProcessTree.track(10, () => ({}), hooks)).rejects.toThrow("iteration limit")
    expect(kills).toEqual([])
    expect(alerts[0]).toBe(ProcessTree.FAILS)
  })

  it("kills the root and tracked descendants and returns the exit code on stop", async () => {
    const kills: number[][] = []
    let checks = 0
    let dead = false
    const hooks: ProcessTree.Hooks = {
      snapshot: async () => step(true, dead ? [] : [row(11, 10)]),
      kill: async (items) => {
        kills.push([...items])
        dead = true
      },
      control: async () => ++checks > 1,
      clear: async () => {},
      sleep: async () => {},
      now: () => 0,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => (dead ? { code: 0 } : {}), hooks)).resolves.toBe(0)
    expect(kills).toEqual([[10, 11]])
  })

  it("stays pending when stop cannot be confirmed and finishes after recovery", async () => {
    const kills: number[][] = []
    let checks = 0
    let clock = 0
    let ticks = 0
    let recovered = false
    const hooks: ProcessTree.Hooks = {
      snapshot: async () => (recovered ? step(true) : step(false)),
      kill: async (items) => {
        kills.push([...items])
      },
      control: async () => ++checks > 1,
      clear: async () => {},
      sleep: async (ms) => {
        clock += ms
        ticks += 1
        if (ticks > 20) recovered = true
      },
      now: () => clock,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => ({ code: 0, exited: 0 }), hooks)).resolves.toBe(0)
    expect(kills).toEqual([[10]])
    expect(ticks).toBeGreaterThan(20)
  })

  it("does not finish while the tracked snapshot cannot be trusted", async () => {
    let clock = 0
    let ticks = 0
    const hooks: ProcessTree.Hooks = {
      snapshot: async () => step(false),
      kill: async () => {
        throw new Error("must not kill")
      },
      control: async () => false,
      clear: async () => {},
      sleep: async (ms) => {
        clock += ms
        ticks += 1
        if (ticks > 300) throw new Error("iteration limit")
      },
      now: () => clock,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => ({ code: 0, exited: 0 }), hooks)).rejects.toThrow("iteration limit")
  })

  it("handles a pending stop before scheduling another scan", async () => {
    const events: string[] = []
    const hooks: ProcessTree.Hooks = {
      snapshot: async (maxAge) => {
        events.push(`snapshot:${maxAge}`)
        return step(true)
      },
      kill: async () => {
        events.push("kill")
      },
      control: async () => {
        events.push("control")
        return true
      },
      clear: async () => {
        events.push("clear")
      },
      sleep: async () => {},
      now: () => 0,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => ({ code: 0, exited: 0 }), hooks)).resolves.toBe(0)
    expect(events.slice(0, 3)).toEqual(["control", "clear", "kill"])
    expect(events).toContain(`snapshot:${ProcessTree.WATCH}`)
    expect(events).not.toContain(`snapshot:${ProcessTree.SCAN}`)
  })

  it("rethrows a recorded spawn failure", async () => {
    let ticks = 0
    const hooks: ProcessTree.Hooks = {
      snapshot: async () => step(true),
      kill: async () => {},
      control: async () => false,
      clear: async () => {},
      sleep: async () => {
        ticks += 1
        if (ticks > 5) throw new Error("iteration limit")
      },
      now: () => 0,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => ({ failure: new Error("spawn failed") }), hooks)).rejects.toThrow(
      "spawn failed",
    )
  })

  it("passes the interrupt signal into normal snapshots", async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | undefined> = []
    let ticks = 0
    const hooks: ProcessTree.Hooks = {
      snapshot: async (_maxAge, signal) => {
        signals.push(signal)
        return step(true)
      },
      kill: async () => {},
      control: async () => false,
      clear: async () => {},
      sleep: async () => {
        ticks += 1
        if (ticks > 2) throw new Error("iteration limit")
      },
      now: () => 0,
      alert: () => {},
      interrupt: controller.signal,
    }
    await expect(ProcessTree.track(10, () => ({}), hooks)).rejects.toThrow("iteration limit")
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal === controller.signal)).toBe(true)
  })

  it("kills descendants discovered on later stop scans", async () => {
    const kills: number[][] = []
    let checks = 0
    let scans = 0
    const hooks: ProcessTree.Hooks = {
      snapshot: async (maxAge) => {
        if (maxAge === ProcessTree.SCAN) return step(true, [row(11, 10)])
        scans += 1
        if (scans === 1) return step(true, [row(11, 10)])
        if (scans === 2) return step(true, [row(12, 10)])
        return step(true)
      },
      kill: async (items) => {
        kills.push([...items])
      },
      control: async () => ++checks > 1,
      clear: async () => {},
      sleep: async () => {},
      now: () => 0,
      alert: () => {},
    }
    await expect(ProcessTree.track(10, () => ({ code: 0, exited: 0 }), hooks)).resolves.toBe(0)
    expect(kills).toEqual([[10, 11], [12]])
  })
})
