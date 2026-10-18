import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"
import { Activity } from "../../src/services/caffeination/activity"
import { createPowerDriver, type PowerDriver, type SleepMode } from "../../src/services/caffeination/power"
import { SleepService } from "../../src/services/caffeination/sleep"
import { check, choices, label, sane } from "../../src/services/caffeination/sleep-delay"

const root = "/workspace"

const status = (sessionID: string, type: "busy" | "retry" | "idle") =>
  ({ id: "e", type: "session.status", properties: { sessionID, status: { type } } }) as SSEPayload
const created = (id: string, parentID?: string) =>
  ({ id: "e", type: "session.created", properties: { sessionID: id, info: { id, parentID } } }) as SSEPayload
const asked = (id: string, sessionID: string, type: "permission.asked" | "question.asked" = "permission.asked") =>
  ({ id: "e", type, properties: { id, sessionID } }) as SSEPayload
const replied = (requestID: string, type: "permission.replied" | "question.replied" | "question.rejected") =>
  ({ id: "e", type, properties: { sessionID: "x", requestID } }) as SSEPayload
const wakeup = (sessionID: string, pending: number) =>
  ({ id: "e", type: "session.wakeup", properties: { sessionID, pending } }) as SSEPayload
const error = (sessionID: string) => ({ id: "e", type: "session.error", properties: { sessionID } }) as SSEPayload
const deleted = (sessionID: string) =>
  ({ id: "e", type: "session.deleted", properties: { sessionID, info: { id: sessionID } } }) as SSEPayload

describe("sleep timer activity", () => {
  it("settles when nothing is running", () => {
    const activity = new Activity()
    expect(activity.settled()).toBe(true)
    activity.apply(status("a", "busy"))
    expect(activity.settled()).toBe(false)
    activity.apply(status("a", "idle"))
    expect(activity.settled()).toBe(true)
  })

  it("treats a session waiting for permission or an answer as done, until it is answered", () => {
    for (const type of ["permission.asked", "question.asked"] as const) {
      const activity = new Activity()
      activity.apply(status("a", "busy"))
      activity.apply(asked("r1", "a", type))
      expect(activity.settled()).toBe(true)
      activity.apply(replied("r1", type === "permission.asked" ? "permission.replied" : "question.replied"))
      expect(activity.settled()).toBe(false)
    }
    const activity = new Activity()
    activity.apply(status("a", "busy"))
    activity.apply(asked("r1", "a", "question.asked"))
    activity.apply(replied("r1", "question.rejected"))
    expect(activity.settled()).toBe(false)
  })

  it("forgets a request whose session stopped without a reply", () => {
    const stops = [status("a", "idle"), { id: "e", type: "session.idle", properties: { sessionID: "a" } }, error("a")]
    for (const stop of stops) {
      const activity = new Activity()
      activity.apply(status("a", "busy"))
      activity.apply(asked("r1", "a"))
      expect(activity.settled()).toBe(true)
      activity.apply(stop as SSEPayload)
      expect(activity.settled()).toBe(true)
      activity.apply(status("a", "busy"))
      expect(activity.settled()).toBe(false)
    }
  })

  it("does not treat a retrying session as stuck", () => {
    const activity = new Activity()
    activity.apply(status("a", "retry"))
    expect(activity.settled()).toBe(false)
  })

  it("treats a busy parent as done when its only busy child is blocked", () => {
    const activity = new Activity()
    activity.apply(created("child", "parent"))
    activity.apply(status("parent", "busy"))
    activity.apply(status("child", "busy"))
    expect(activity.settled()).toBe(false)
    activity.apply(asked("r1", "child"))
    expect(activity.settled()).toBe(true)
  })

  it("keeps waiting while a sibling subagent is still working", () => {
    const activity = new Activity()
    activity.apply(created("one", "parent"))
    activity.apply(created("two", "parent"))
    for (const id of ["parent", "one", "two"]) activity.apply(status(id, "busy"))
    activity.apply(asked("r1", "one"))
    expect(activity.settled()).toBe(false)
    activity.apply(status("two", "idle"))
    expect(activity.settled()).toBe(true)
  })

  it("keeps a parent running once its blocked child is gone", () => {
    const activity = new Activity()
    activity.apply(created("child", "parent"))
    activity.apply(status("parent", "busy"))
    activity.apply(status("child", "busy"))
    activity.apply(asked("r1", "child"))
    expect(activity.settled()).toBe(true)
    activity.apply(status("child", "idle"))
    expect(activity.settled()).toBe(false)
  })

  it("treats a busy session with unknown ancestry as a running root", () => {
    const activity = new Activity()
    activity.apply(status("orphan", "busy"))
    expect(activity.settled()).toBe(false)
  })

  it("counts pending wakeups as work and forgets deleted sessions", () => {
    const activity = new Activity()
    activity.apply(wakeup("a", 1))
    expect(activity.settled()).toBe(false)
    activity.apply(wakeup("a", 0))
    expect(activity.settled()).toBe(true)
    activity.apply(status("b", "busy"))
    activity.apply(asked("r1", "b"))
    activity.apply(deleted("b"))
    activity.apply(status("b", "busy"))
    expect(activity.settled()).toBe(false)
  })

  it("restores from a snapshot", () => {
    const activity = new Activity()
    activity.reset({ busy: ["p", "c"], wake: [], asked: { r1: "c" }, parent: { p: null, c: "p" } })
    expect(activity.settled()).toBe(true)
    activity.reset({ busy: ["p"], wake: [], asked: {}, parent: { p: null } })
    expect(activity.settled()).toBe(false)
  })
})

type Data = {
  status: Record<string, { type: string }>
  parents: Record<string, string | undefined>
  perms: { id: string; sessionID: string }[]
  asks: { id: string; sessionID: string }[]
  wake: { sessionID: string; pending: number }[]
}

function setup(initial: Partial<Data> = {}, opts: { grace?: number; hibernate?: boolean } = {}) {
  const data: Data = { status: {}, parents: {}, perms: [], asks: [], wake: [], ...initial }
  const events = new Set<(event: SSEPayload, dir?: string) => void>()
  const states = new Set<(state: ConnectionState) => void>()
  const connection = {
    state: "connected" as ConnectionState,
    loads: 0,
    delay: 0,
    onEvent: (listener: (event: SSEPayload, dir?: string) => void) => {
      events.add(listener)
      return () => events.delete(listener)
    },
    onStateChange: (listener: (state: ConnectionState) => void) => {
      states.add(listener)
      return () => states.delete(listener)
    },
    getConnectionState: () => connection.state,
    getKnownDirectories: () => [root],
    getClient: () =>
      ({
        session: {
          status: async () => {
            connection.loads++
            if (connection.delay) await Bun.sleep(connection.delay)
            return { data: structuredClone(data.status) }
          },
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: sessionID, parentID: data.parents[sessionID] },
          }),
        },
        kilocode: { wakeups: async () => ({ data: data.wake }) },
        permission: { list: async () => ({ data: data.perms }) },
        question: { list: async () => ({ data: data.asks }) },
      }) as unknown as KiloClient,
  }
  const power = {
    available: true,
    hibernate: opts.hibernate ?? true,
    runs: [] as SleepMode[],
    order: [] as string[],
    fail: undefined as string | undefined,
    problem: undefined as string | undefined,
    check: async (): Promise<string | undefined> => power.problem,
    run: async (mode: SleepMode): Promise<void> => {
      power.order.push("run")
      power.runs.push(mode)
      if (power.fail) throw new Error(power.fail)
    },
  } satisfies PowerDriver & Record<string, unknown>
  const before = { calls: 0 }
  const service = new SleepService(connection, power, {
    grace: opts.grace ?? 40,
    before: async () => {
      before.calls++
      power.order.push("before")
    },
  })
  const emit = (event: SSEPayload) => {
    for (const listener of events) listener(event, root)
  }
  const change = (state: ConnectionState) => {
    connection.state = state
    for (const listener of states) listener(state)
  }
  const phases: string[] = []
  service.onChange((state) => phases.push(state.phase))
  return { service, power, connection, data, before, emit, change, phases }
}

async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}

describe("sleep timer service", () => {
  it("sleeps once after the grace period when everything is idle", async () => {
    const t = setup()
    await t.service.arm("sleep")
    expect(t.service.getState()).toMatchObject({ mode: "sleep", phase: "countdown" })
    await until(() => t.power.runs.length === 1)
    expect(t.power.runs).toEqual(["sleep"])
    expect(t.service.getState()).toMatchObject({ mode: undefined, phase: "off" })
    expect(t.power.order).toEqual(["before", "run"])
    t.emit(status("a", "busy"))
    t.emit(status("a", "idle"))
    await Bun.sleep(100)
    expect(t.power.runs).toEqual(["sleep"])
  })

  it("reports when the countdown after the agents finish will fire", async () => {
    const t = setup({}, { grace: 120 })
    const start = Date.now()
    await t.service.arm("sleep")
    const state = t.service.getState()
    expect(state).toMatchObject({ mode: "sleep", kind: "agents", phase: "countdown" })
    expect(state.deadline).toBeGreaterThanOrEqual(start + 120)
    expect(state.deadline).toBeLessThan(start + 120 + 100)
    t.emit(status("a", "busy"))
    expect(t.service.getState().phase).toBe("waiting")
    expect(t.service.getState().deadline).toBeUndefined()
  })

  it("hibernates when asked to", async () => {
    const t = setup()
    await t.service.arm("hibernate")
    await until(() => t.power.runs.length === 1)
    expect(t.power.runs).toEqual(["hibernate"])
  })

  it("waits for running agents and then counts down", async () => {
    const t = setup({ status: { a: { type: "busy" } }, parents: { a: undefined } })
    await t.service.arm("sleep")
    expect(t.service.getState().phase).toBe("waiting")
    await Bun.sleep(100)
    expect(t.power.runs).toEqual([])
    t.emit(status("a", "idle"))
    expect(t.service.getState().phase).toBe("countdown")
    await until(() => t.power.runs.length === 1)
  })

  it("does not wait for a session that is stuck on a permission already pending when armed", async () => {
    const t = setup({
      status: { a: { type: "busy" } },
      parents: { a: undefined },
      perms: [{ id: "r1", sessionID: "a" }],
    })
    await t.service.arm("sleep")
    expect(t.service.getState().phase).toBe("countdown")
    await until(() => t.power.runs.length === 1)
  })

  it("does not wait for a parent whose subagent is stuck on a question", async () => {
    const t = setup({
      status: { parent: { type: "busy" }, child: { type: "busy" } },
      parents: { parent: undefined, child: "parent" },
      asks: [{ id: "q1", sessionID: "child" }],
    })
    await t.service.arm("sleep")
    expect(t.service.getState().phase).toBe("countdown")
    await until(() => t.power.runs.length === 1)
  })

  it("keeps a retrying session as work", async () => {
    const t = setup({ status: { a: { type: "retry" } }, parents: { a: undefined } })
    await t.service.arm("sleep")
    await Bun.sleep(100)
    expect(t.service.getState().phase).toBe("waiting")
    expect(t.power.runs).toEqual([])
  })

  it("starts counting down when a session gets stuck while armed", async () => {
    const t = setup({ status: { a: { type: "busy" } }, parents: { a: undefined } })
    await t.service.arm("sleep")
    t.emit(asked("r1", "a"))
    expect(t.service.getState().phase).toBe("countdown")
    await until(() => t.power.runs.length === 1)
  })

  it("aborts the countdown when work starts again", async () => {
    const t = setup({}, { grace: 80 })
    await t.service.arm("sleep")
    expect(t.service.getState().phase).toBe("countdown")
    t.emit(status("a", "busy"))
    expect(t.service.getState()).toMatchObject({ mode: "sleep", phase: "waiting" })
    await Bun.sleep(150)
    expect(t.power.runs).toEqual([])
    t.emit(status("a", "idle"))
    await until(() => t.power.runs.length === 1)
  })

  it("aborts the countdown when a stuck session is answered", async () => {
    const t = setup({ status: { a: { type: "busy" } }, parents: { a: undefined } }, { grace: 80 })
    await t.service.arm("sleep")
    t.emit(asked("r1", "a"))
    expect(t.service.getState().phase).toBe("countdown")
    t.emit(replied("r1", "permission.replied"))
    expect(t.service.getState().phase).toBe("waiting")
    await Bun.sleep(150)
    expect(t.power.runs).toEqual([])
  })

  it("does not sleep when cancelled", async () => {
    const t = setup({}, { grace: 80 })
    await t.service.arm("sleep")
    t.service.cancel()
    expect(t.service.getState()).toMatchObject({ mode: undefined, phase: "off" })
    await Bun.sleep(150)
    expect(t.power.runs).toEqual([])
  })

  it("does not sleep while the backend is disconnected and reloads activity on reconnect", async () => {
    const t = setup({}, { grace: 80 })
    await t.service.arm("sleep")
    t.change("disconnected")
    expect(t.service.getState()).toMatchObject({ mode: "sleep", phase: "waiting" })
    await Bun.sleep(150)
    expect(t.power.runs).toEqual([])
    t.data.status = { a: { type: "busy" } }
    t.data.parents = { a: undefined }
    t.change("connected")
    await Bun.sleep(150)
    expect(t.power.runs).toEqual([])
    expect(t.service.getState().phase).toBe("waiting")
    t.data.status = {}
    t.emit(status("a", "idle"))
    await until(() => t.power.runs.length === 1)
  })

  it("applies events that arrive while the first snapshot loads", async () => {
    const t = setup()
    t.connection.delay = 40
    const arming = t.service.arm("sleep")
    await Bun.sleep(10)
    t.emit(status("a", "busy"))
    await arming
    expect(t.service.getState().phase).toBe("waiting")
    await Bun.sleep(120)
    expect(t.power.runs).toEqual([])
  })

  it("counts pending wakeups as work", async () => {
    const t = setup({ wake: [{ sessionID: "a", pending: 1 }] })
    await t.service.arm("sleep")
    await Bun.sleep(100)
    expect(t.service.getState().phase).toBe("waiting")
    t.emit(wakeup("a", 0))
    await until(() => t.power.runs.length === 1)
  })

  it("reports a failed suspend and stays disarmed", async () => {
    const t = setup()
    t.power.fail = "no permission"
    await t.service.arm("sleep")
    await until(() => t.service.getState().error === "no permission")
    expect(t.service.getState().mode).toBeUndefined()
  })

  it("refuses modes the platform cannot do", async () => {
    const t = setup({}, { hibernate: false })
    await t.service.arm("hibernate")
    expect(t.service.getState().mode).toBeUndefined()
    expect(t.service.getState().phase).toBe("off")
    expect(t.service.getState().error).toContain("Hibernation")
    t.power.problem = "Hibernation is not enabled"
    await t.service.arm("sleep")
    expect(t.service.getState().mode).toBeUndefined()
    expect(t.service.getState().error).toBe("Hibernation is not enabled")
  })

  it("does not act after dispose", async () => {
    const t = setup({}, { grace: 40 })
    await t.service.arm("sleep")
    t.service.dispose()
    await Bun.sleep(100)
    expect(t.power.runs).toEqual([])
  })
})

describe("plain sleep timer", () => {
  it("sleeps after the delay whatever the agents are doing", async () => {
    const t = setup({ status: { a: { type: "busy" } }, parents: { a: undefined } })
    const start = Date.now()
    await t.service.schedule("sleep", 120)
    const state = t.service.getState()
    expect(state).toMatchObject({ mode: "sleep", kind: "time", phase: "countdown" })
    expect(state.deadline).toBeGreaterThanOrEqual(start + 120)
    expect(t.connection.loads).toBe(0)
    t.emit(status("b", "busy"))
    t.emit(asked("r1", "b"))
    await Bun.sleep(60)
    expect(t.power.runs).toEqual([])
    await until(() => t.power.runs.length === 1)
    expect(Date.now() - start).toBeGreaterThanOrEqual(115)
    expect(t.power.order).toEqual(["before", "run"])
    expect(t.service.getState()).toMatchObject({ phase: "off" })
    expect(t.service.getState().mode).toBeUndefined()
    expect(t.service.getState().kind).toBeUndefined()
    expect(t.service.getState().deadline).toBeUndefined()
  })

  it("hibernates when asked to", async () => {
    const t = setup()
    await t.service.schedule("hibernate", 30)
    await until(() => t.power.runs.length === 1)
    expect(t.power.runs).toEqual(["hibernate"])
  })

  it("keeps counting through a backend disconnect and reconnect", async () => {
    const t = setup()
    await t.service.schedule("sleep", 150)
    t.change("disconnected")
    t.change("connected")
    expect(t.service.getState()).toMatchObject({ mode: "sleep", kind: "time", phase: "countdown" })
    expect(t.connection.loads).toBe(0)
    await until(() => t.power.runs.length === 1)
  })

  it("can be cancelled", async () => {
    const t = setup()
    await t.service.schedule("sleep", 60)
    t.service.cancel()
    expect(t.service.getState().phase).toBe("off")
    await Bun.sleep(120)
    expect(t.power.runs).toEqual([])
  })

  it("is replaced by the agent-based timer, which then watches the agents", async () => {
    const t = setup({ status: { a: { type: "busy" } }, parents: { a: undefined } })
    await t.service.schedule("sleep", 60)
    await t.service.arm("hibernate")
    expect(t.service.getState()).toMatchObject({ mode: "hibernate", kind: "agents", phase: "waiting" })
    await Bun.sleep(120)
    expect(t.power.runs).toEqual([])
    t.emit(status("a", "idle"))
    await until(() => t.power.runs.length === 1)
    expect(t.power.runs).toEqual(["hibernate"])
  })

  it("replaces the agent-based timer and stops watching the agents", async () => {
    const t = setup({}, { grace: 400 })
    await t.service.arm("sleep")
    expect(t.service.getState().kind).toBe("agents")
    await t.service.schedule("hibernate", 60)
    expect(t.service.getState()).toMatchObject({ mode: "hibernate", kind: "time" })
    t.emit(status("a", "busy"))
    expect(t.service.getState().phase).toBe("countdown")
    await until(() => t.power.runs.length === 1)
    expect(t.power.runs).toEqual(["hibernate"])
    await Bun.sleep(450)
    expect(t.power.runs).toEqual(["hibernate"])
  })

  it("re-arming with a new delay restarts the countdown", async () => {
    const t = setup()
    await t.service.schedule("sleep", 400)
    await t.service.schedule("sleep", 50)
    await until(() => t.power.runs.length === 1)
    await Bun.sleep(450)
    expect(t.power.runs).toEqual(["sleep"])
  })

  it("refuses modes the platform cannot do and does nothing after dispose", async () => {
    const t = setup({}, { hibernate: false })
    await t.service.schedule("hibernate", 30)
    expect(t.service.getState().mode).toBeUndefined()
    expect(t.service.getState().error).toContain("Hibernation")
    await t.service.schedule("sleep", 60)
    t.service.dispose()
    await Bun.sleep(120)
    expect(t.power.runs).toEqual([])
  })

  it("reports a failed suspend", async () => {
    const t = setup()
    t.power.fail = "no permission"
    await t.service.schedule("sleep", 20)
    await until(() => t.service.getState().error === "no permission")
    expect(t.service.getState().mode).toBeUndefined()
  })
})

describe("power driver", () => {
  const calls = (platform: NodeJS.Platform, extra: { stdout?: string } = {}) => {
    const log: { cmd: string; args: string[] }[] = []
    const driver = createPowerDriver({
      platform,
      exists: () => true,
      exec: async (cmd, args) => {
        log.push({ cmd, args })
        return { stdout: extra.stdout ?? "", stderr: "" }
      },
    })
    return { driver, log }
  }

  it("suspends and hibernates through systemctl on Linux", async () => {
    const { driver, log } = calls("linux")
    await driver.run("sleep")
    await driver.run("hibernate")
    expect(log.map((item) => item.args)).toEqual([["suspend"], ["hibernate"]])
  })

  it("only offers sleep on macOS", async () => {
    const { driver, log } = calls("darwin")
    expect(driver.hibernate).toBe(false)
    await driver.run("sleep")
    expect(log).toEqual([{ cmd: "/usr/bin/pmset", args: ["sleepnow"] }])
  })

  it("calls SetSuspendState directly on Windows", async () => {
    const { driver, log } = calls("win32")
    await driver.run("sleep")
    await driver.run("hibernate")
    const scripts = log.map((item) => item.args.at(-1) ?? "")
    expect(scripts[0]).toContain("SetSuspendState($false, $false, $false)")
    expect(scripts[1]).toContain("SetSuspendState($true, $false, $false)")
    expect(scripts[0]).not.toContain("rundll32")
  })

  it("rejects hibernate on Windows when hibernation is turned off", async () => {
    const off = calls("win32", { stdout: "    HibernateEnabled    REG_DWORD    0x0\r\n" })
    expect(await off.driver.check("hibernate")).toContain("powercfg /hibernate on")
    expect(await off.driver.check("sleep")).toBeUndefined()
    const on = calls("win32", { stdout: "    HibernateEnabled    REG_DWORD    0x1\r\n" })
    expect(await on.driver.check("hibernate")).toBeUndefined()
  })

  it("reports a platform that cannot suspend", async () => {
    const driver = createPowerDriver({ platform: "freebsd" })
    expect(driver.available).toBe(false)
    await expect(driver.run("sleep")).rejects.toThrow("not supported")
    expect(createPowerDriver({ platform: "linux", reason: "remote" }).reason).toBe("remote")
    expect(createPowerDriver({ platform: "linux", exists: () => false }).available).toBe(false)
  })

  it("surfaces the command's error output", async () => {
    const driver = createPowerDriver({
      platform: "linux",
      exists: () => true,
      exec: async () => {
        throw Object.assign(new Error("failed"), { stderr: "Operation inhibited\n" })
      },
    })
    await expect(driver.run("sleep")).rejects.toThrow("Operation inhibited")
  })
})

describe("sleep timer delay choices", () => {
  it("lists the last used delay first without repeating it", () => {
    expect(choices(30)).toEqual([30, 5, 15, 60, 120])
    expect(choices(5)).toEqual([5, 15, 30, 60, 120])
    expect(choices(45)).toEqual([45, 5, 15, 30, 60, 120])
  })

  it("names delays in minutes and hours", () => {
    expect(label(1)).toBe("1 minute")
    expect(label(5)).toBe("5 minutes")
    expect(label(90)).toBe("90 minutes")
    expect(label(60)).toBe("1 hour")
    expect(label(120)).toBe("2 hours")
  })

  it("accepts whole minutes from one minute to a day", () => {
    for (const text of ["1", "45", " 90 ", "1440"]) expect(check(text)).toBeUndefined()
    for (const text of ["", "  ", "0", "-5", "1.5", "abc", "1441", "1e3x"]) expect(check(text)).toContain("1 to 1440")
  })

  it("does not trust stored values that typed input would reject", () => {
    expect(sane(15)).toBe(true)
    for (const value of [undefined, null, "15", 0, 2.5, 5000, Number.NaN]) expect(sane(value)).toBe(false)
  })
})
