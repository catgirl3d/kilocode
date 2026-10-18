// fork_change - new file
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../cli-backend/connection-service"
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"
import { Activity, tracked, type Snapshot } from "./activity"
import type { PowerDriver, SleepMode } from "./power"

/** Countdown after the agents finish, and lead time of the cancellable warning. */
export const GRACE = 60_000

/** "agents" waits for the sessions to finish; "time" counts down regardless of them. */
type SleepKind = "agents" | "time"

interface SleepState {
  /** Armed mode; absent when the timer is off. */
  mode?: SleepMode
  kind?: SleepKind
  /** When the suspend happens; only set while counting down. */
  deadline?: number
  phase: "off" | "waiting" | "countdown"
  available: boolean
  hibernate: boolean
  error?: string
}

export interface SleepControls {
  getState(): SleepState
  onChange(listener: (state: SleepState) => void): () => void
  set(mode?: SleepMode, kind?: SleepKind): Promise<void>
}

type Listener = (state: SleepState) => void

export interface Connection {
  onEvent(listener: (event: SSEPayload, directory?: string) => void): () => void
  onStateChange(listener: (state: ConnectionState) => void): () => void
  getConnectionState(): ConnectionState
  getKnownDirectories(): string[]
  getClient(): KiloClient
}

/**
 * One-shot sleep timer.
 *
 * Armed with {@link arm} it waits for every session to be idle or waiting for
 * the user, counts down a grace period, and then puts the computer to sleep or
 * hibernation. It never fires from a stale view: after arming and after every
 * reconnect the activity is reloaded first, and a disconnect only pauses it.
 * Armed with {@link schedule} it is a plain countdown that ignores the agents.
 */
export class SleepService {
  private readonly activity = new Activity()
  private readonly listeners = new Set<Listener>()
  private readonly unsubscribe: (() => void)[]
  private readonly grace: number
  private state: SleepState
  private buffer: SSEPayload[] = []
  private loaded = false
  private disposed = false
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly connection: Connection,
    private readonly power: PowerDriver,
    private readonly opts: { grace?: number; before?: () => Promise<void> } = {},
  ) {
    this.grace = opts.grace ?? GRACE
    this.state = {
      phase: "off",
      available: power.available,
      hibernate: power.hibernate,
      error: power.available ? undefined : power.reason,
    }
    this.unsubscribe = [
      connection.onEvent((event) => this.event(event)),
      connection.onStateChange((state) => {
        if (this.state.kind === "time") return
        if (state === "connected") {
          void this.refresh()
          return
        }
        this.epoch++
        this.loaded = false
        this.abort()
      }),
    ]
  }

  getState(): SleepState {
    return this.state
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async arm(mode: SleepMode): Promise<void> {
    if (!(await this.allowed(mode))) return
    this.stop()
    this.update({ mode, kind: "agents", deadline: undefined, phase: "waiting" })
    await this.refresh()
  }

  /** Sleep after a fixed delay, whatever the agents are doing. */
  async schedule(mode: SleepMode, delay: number): Promise<void> {
    if (!(await this.allowed(mode))) return
    this.epoch++
    this.loaded = false
    this.stop()
    this.timer = setTimeout(() => void this.fire(), delay)
    this.update({ mode, kind: "time", deadline: Date.now() + delay, phase: "countdown" })
  }

  cancel(): void {
    this.epoch++
    this.loaded = false
    this.stop()
    this.update({ mode: undefined, kind: undefined, deadline: undefined, phase: "off", error: undefined })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch++
    this.stop()
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.listeners.clear()
  }

  private async allowed(mode: SleepMode): Promise<boolean> {
    if (this.disposed) return false
    this.update({ error: undefined })
    if (!this.power.available) return this.fail(this.power.reason)
    if (mode === "hibernate" && !this.power.hibernate) return this.fail("Hibernation is not available on this platform")
    const problem = await this.power.check(mode)
    if (this.disposed) return false
    return problem ? this.fail(problem) : true
  }

  private fail(error?: string): false {
    this.update({ error })
    return false
  }

  private ready(): boolean {
    return (
      !this.disposed &&
      this.state.mode !== undefined &&
      this.loaded &&
      this.connection.getConnectionState() === "connected"
    )
  }

  private event(event: SSEPayload): void {
    if (!this.state.mode || this.state.kind === "time") return
    if (event.type === "server.instance.disposed") {
      void this.refresh()
      return
    }
    if (!tracked(event)) return
    if (!this.loaded) {
      this.buffer.push(event)
      return
    }
    this.activity.apply(event)
    this.evaluate()
  }

  private async refresh(): Promise<void> {
    if (this.disposed || !this.state.mode || this.state.kind === "time") return
    if (this.connection.getConnectionState() !== "connected") return
    const epoch = ++this.epoch
    this.loaded = false
    this.buffer = []
    this.abort()
    const result = await this.snapshot().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if (epoch !== this.epoch || !this.state.mode) return
    if ("error" in result) {
      console.warn("[Kilo New] Sleep timer status refresh failed:", result.error)
      this.update({
        mode: undefined,
        kind: undefined,
        deadline: undefined,
        phase: "off",
        error: "Could not check whether Kilo agents are still working",
      })
      return
    }
    this.activity.reset(result.value)
    for (const event of this.buffer.splice(0)) this.activity.apply(event)
    this.loaded = true
    this.evaluate()
  }

  private async snapshot(): Promise<Snapshot> {
    const client = this.connection.getClient()
    const out: Snapshot = { busy: [], wake: [], asked: {}, parent: {} }
    const dirs = [...new Set(this.connection.getKnownDirectories().filter(Boolean))]
    await Promise.all(
      dirs.map(async (directory) => {
        const [status, wake, perms, asks] = await Promise.all([
          client.session.status({ directory }, { throwOnError: true }),
          client.kilocode.wakeups({ directory }, { throwOnError: true }),
          client.permission.list({ directory }, { throwOnError: true }),
          client.question.list({ directory }, { throwOnError: true }),
        ])
        const busy = Object.entries(status.data ?? {})
          .filter(([, item]) => item.type === "busy" || item.type === "retry")
          .map(([id]) => id)
        out.busy.push(...busy)
        for (const item of wake.data ?? []) if (item.pending > 0) out.wake.push(item.sessionID)
        for (const item of [...(perms.data ?? []), ...(asks.data ?? [])]) out.asked[item.id] = item.sessionID
        await Promise.all(
          busy.map(async (sessionID) => {
            const res = await client.session.get({ sessionID, directory }, { throwOnError: true })
            out.parent[sessionID] = res.data.parentID ?? null
          }),
        )
      }),
    )
    return out
  }

  private evaluate(): void {
    if (!this.ready()) return
    const settled = this.activity.settled()
    if (settled && !this.timer) this.countdown()
    if (!settled && this.timer) this.abort()
  }

  private countdown(): void {
    this.timer = setTimeout(() => void this.fire(), this.grace)
    this.update({ phase: "countdown", deadline: Date.now() + this.grace })
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private abort(): void {
    this.stop()
    if (this.state.phase === "countdown") this.update({ phase: "waiting", deadline: undefined })
  }

  private async fire(): Promise<void> {
    this.timer = undefined
    const mode = this.state.mode
    if (!mode || (this.state.kind !== "time" && (!this.ready() || !this.activity.settled()))) {
      this.abort()
      return
    }
    // One-shot: disarm before acting so nothing can trigger a second suspend.
    this.epoch++
    this.loaded = false
    this.update({ mode: undefined, kind: undefined, deadline: undefined, phase: "off" })
    await Promise.resolve(this.opts.before?.())
      .catch((error: unknown) => console.warn("[Kilo New] Sleep timer pre-sleep step failed:", error))
      .then(() => this.power.run(mode))
      .catch((error: unknown) => this.update({ error: error instanceof Error ? error.message : String(error) }))
  }

  private update(next: Partial<SleepState>): void {
    const state = { ...this.state, ...next }
    if (Object.keys(state).every((key) => state[key as keyof SleepState] === this.state[key as keyof SleepState]))
      return
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
