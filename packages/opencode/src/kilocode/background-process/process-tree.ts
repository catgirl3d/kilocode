// fork_change - new file
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import * as Log from "@opencode-ai/core/util/log"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { isRecord } from "@/util/record"
import path from "path"

export namespace ProcessTree {
  const log = Log.create({ service: "background-process" })
  export const SCAN = 2_000
  export const WATCH = 150
  export const BACKOFF = 30_000
  export const FAILS = 5
  // Grace window after the leader exits during which we keep walking from its
  // pid. A detached descendant spawned just before the leader died may not yet
  // be visible in Win32_Process, and its ParentProcessId still points at the
  // (now dead) leader, so seeding the walk from the leader's pid for a short
  // window lets us capture it before concluding the tree is empty.
  export const GRACE = 1_000
  export const KILL_MS = 5_000
  export const WAIT = 1_500
  export const HOLD = 10_000
  export const CACHE = path.join(Global.Path.state, "background-process", "snapshot.json")
  export const LOCKS = path.join(Global.Path.state, "background-process", "locks")
  const MODE = 0o600

  export type Row = { pid: number; parent: number; birth: string }
  export type Snapshot = { time: number; ok: boolean; rows: Row[] }
  export type Step = { snap: Snapshot; scanned: boolean; fresh: boolean }
  export type Exit = { code?: number; exited?: number; failure?: unknown }

  export type Hooks = {
    snapshot: (maxAge: number, signal?: AbortSignal) => Promise<Step>
    kill: (items: number[]) => Promise<unknown>
    control: () => Promise<boolean>
    clear: () => Promise<void>
    sleep: (ms: number) => Promise<void>
    now: () => number
    alert: (fails: number) => void
    interrupt?: AbortSignal
  }

  async function scan(signal?: AbortSignal): Promise<Snapshot> {
    const query =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"
    const out = await Process.text(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query], {
      nothrow: true,
      abort: signal ? AbortSignal.any([AbortSignal.timeout(2_000), signal]) : AbortSignal.timeout(2_000),
      timeout: 2_000,
    })
    const time = Date.now()
    if (out.code !== 0 || !out.text.trim()) return { time, ok: false, rows: [] }
    let value: unknown
    try {
      value = JSON.parse(out.text)
    } catch {
      return { time, ok: false, rows: [] }
    }
    const items = Array.isArray(value) ? value : [value]
    const rows = items.flatMap((item): Row[] => {
      if (
        !isRecord(item) ||
        typeof item.ProcessId !== "number" ||
        typeof item.ParentProcessId !== "number" ||
        typeof item.CreationDate !== "string"
      )
        return []
      return [{ pid: item.ProcessId, parent: item.ParentProcessId, birth: item.CreationDate }]
    })
    return { time, ok: true, rows }
  }

  async function read(): Promise<Snapshot | undefined> {
    const file = Bun.file(CACHE)
    if (!(await file.exists())) return undefined
    const value: unknown = await file.json().catch(() => undefined)
    if (
      !isRecord(value) ||
      typeof value.time !== "number" ||
      typeof value.ok !== "boolean" ||
      !Array.isArray(value.rows)
    )
      return undefined
    const rows = value.rows.flatMap((item): Row[] => {
      if (
        !isRecord(item) ||
        typeof item.pid !== "number" ||
        typeof item.parent !== "number" ||
        typeof item.birth !== "string"
      )
        return []
      return [{ pid: item.pid, parent: item.parent, birth: item.birth }]
    })
    return { time: value.time, ok: value.ok, rows }
  }

  async function publish(value: Snapshot) {
    await Filesystem.write(CACHE, JSON.stringify(value), MODE)
  }

  export async function snapshot(maxAge: number, signal?: AbortSignal): Promise<Step> {
    const cached = await read()
    if (cached && Date.now() - cached.time < maxAge) return { snap: cached, scanned: false, fresh: true }
    if (signal?.aborted) return { snap: cached ?? { time: 0, ok: false, rows: [] }, scanned: false, fresh: false }
    const lease = await Flock.acquire("background-process:snapshot", {
      dir: LOCKS,
      staleMs: HOLD,
      timeoutMs: WAIT,
      baseDelayMs: 50,
      maxDelayMs: 250,
      signal,
    }).catch(() => undefined)
    if (lease) {
      try {
        const fresh = await read()
        if (fresh && Date.now() - fresh.time < maxAge) return { snap: fresh, scanned: false, fresh: true }
        const next = await scan(signal)
        if (!signal?.aborted) await publish(next)
        return { snap: next, scanned: true, fresh: true }
      } finally {
        await lease.release().catch((err) => log.warn("failed to release background process snapshot lock", { err }))
      }
    }
    const end = Date.now() + WAIT
    while (!signal?.aborted && Date.now() < end) {
      await Bun.sleep(50)
      const next = await read()
      if (next && Date.now() - next.time < maxAge) return { snap: next, scanned: false, fresh: true }
    }
    return { snap: cached ?? { time: 0, ok: false, rows: [] }, scanned: false, fresh: false }
  }

  export function descendants(root: number, seen: Map<number, string>, active: boolean, snap: Snapshot) {
    if (!snap.ok) return seen
    const live = new Map(snap.rows.map((item) => [item.pid, item.birth]))
    const children = new Map<number, Array<{ pid: number; birth: string }>>()
    for (const row of snap.rows) {
      let list = children.get(row.parent)
      if (!list) {
        list = []
        children.set(row.parent, list)
      }
      list.push({ pid: row.pid, birth: row.birth })
    }
    const result = new Map(Array.from(seen).filter(([pid, birth]) => live.get(pid) === birth))
    const stack = [...(active ? [root] : []), ...result.keys()]
    while (stack.length > 0) {
      const pid = stack.pop()
      if (!pid) continue
      for (const child of children.get(pid) ?? []) {
        if (result.has(child.pid)) continue
        result.set(child.pid, child.birth)
        stack.push(child.pid)
      }
    }
    return result
  }

  export function pace(state: { grace: boolean; ok: boolean; scanned: boolean; fails: number; delay: number }) {
    if (state.ok) return { fails: 0, delay: state.grace ? WATCH : SCAN }
    if (!state.scanned) return { fails: state.fails, delay: state.delay }
    return { fails: state.fails + 1, delay: Math.min(state.delay * 2, BACKOFF) }
  }

  export function targets(pid: number, seen: Map<number, string>, killed: Set<number>, safe: boolean) {
    return [...(safe ? [pid] : []), ...seen.keys()].filter((item) => !killed.has(item))
  }

  export async function track(pid: number, exit: () => Exit, hooks: Hooks): Promise<number> {
    let seen = new Map<number, string>()
    let delay = SCAN
    let fails = 0
    let next = 0
    let ok = false
    let watch = false
    let born: string | undefined
    let home = true
    const intact = (snap: Snapshot) => {
      if (!born) born = snap.rows.find((row) => row.pid === pid)?.birth
      const live = snap.rows.find((row) => row.pid === pid)
      return born === undefined || !live || live.birth === born
    }
    while (true) {
      const status = exit()
      if (status.failure) throw status.failure
      if (await hooks.control()) {
        await hooks.clear()
        const killed = new Set<number>()
        let pause = WATCH
        const end = hooks.now() + KILL_MS
        while (true) {
          const first = targets(pid, seen, killed, home)
          if (first.length > 0) {
            await hooks.kill(first)
            for (const item of first) killed.add(item)
          }
          const step = await hooks.snapshot(WATCH)
          const safe = intact(step.snap)
          home = safe
          seen = descendants(pid, seen, safe, step.snap)
          const later = targets(pid, seen, killed, safe)
          if (later.length > 0) {
            await hooks.kill(later)
            for (const item of later) killed.add(item)
          }
          const code = exit().code
          if (step.fresh && step.snap.ok && code !== undefined && seen.size === 0) return code
          pause = step.fresh && step.snap.ok ? WATCH : Math.min(pause * 2, BACKOFF)
          await hooks.sleep(hooks.now() < end ? WATCH : pause)
        }
      }
      const now = hooks.now()
      const grace = status.exited !== undefined && now - status.exited < GRACE
      const active = status.code === undefined || grace
      if (grace && !watch) next = 0
      watch = grace
      if (now >= next) {
        const step = await hooks.snapshot(grace ? WATCH : SCAN, hooks.interrupt)
        const safe = intact(step.snap)
        home = safe
        seen = descendants(pid, seen, (status.code === undefined || grace) && safe, step.snap)
        ok = step.fresh && step.snap.ok
        const paced = pace({ grace, ok, scanned: step.scanned, fails, delay })
        if (paced.fails !== fails && paced.fails % FAILS === 0) hooks.alert(paced.fails)
        fails = paced.fails
        delay = paced.delay
        next = now + delay
      }
      if (ok && status.code !== undefined && !active && seen.size === 0) return status.code
      await hooks.sleep(100)
    }
  }
}
