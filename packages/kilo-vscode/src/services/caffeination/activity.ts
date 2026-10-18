// fork_change - new file
import type { SSEPayload } from "../cli-backend/sdk-sse-adapter"

export type Snapshot = {
  busy: string[]
  wake: string[]
  /** Pending permission/question request id -> session id. */
  asked: Record<string, string>
  /** Parent of each busy session, null for a root session. */
  parent: Record<string, string | null>
}

const TYPES = new Set<SSEPayload["type"]>([
  "session.status",
  "session.idle",
  "session.error",
  "session.deleted",
  "session.created",
  "session.updated",
  "session.wakeup",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
])

/** Whether the event can change the answer of {@link Activity.settled}. */
export function tracked(event: SSEPayload): boolean {
  return TYPES.has(event.type)
}

/**
 * Tracks which sessions still need the computer.
 *
 * A session that waits for the user (pending permission or question) is not
 * work, and neither is a parent that is busy only because a child is. A busy
 * `task` parent stays busy while its child is blocked, so looking only at the
 * session that owns the request would keep the computer awake forever.
 */
export class Activity {
  private busy = new Set<string>()
  private wake = new Set<string>()
  private asked = new Map<string, string>()
  private parent = new Map<string, string | null>()

  reset(snapshot: Snapshot): void {
    this.busy = new Set(snapshot.busy)
    this.wake = new Set(snapshot.wake)
    this.asked = new Map(Object.entries(snapshot.asked))
    this.parent = new Map(Object.entries(snapshot.parent))
  }

  apply(event: SSEPayload): void {
    if (event.type === "session.created" || event.type === "session.updated") {
      this.parent.set(event.properties.info.id, event.properties.info.parentID ?? null)
      return
    }
    if (event.type === "session.wakeup") {
      if (event.properties.pending > 0) this.wake.add(event.properties.sessionID)
      else this.wake.delete(event.properties.sessionID)
      return
    }
    this.request(event)
    this.lifecycle(event)
  }

  private request(event: SSEPayload): void {
    if (event.type === "permission.asked" || event.type === "question.asked") {
      this.asked.set(event.properties.id, event.properties.sessionID)
      return
    }
    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      this.asked.delete(event.properties.requestID)
    }
  }

  private lifecycle(event: SSEPayload): void {
    if (
      event.type === "session.status" &&
      (event.properties.status.type === "busy" || event.properties.status.type === "retry")
    ) {
      this.busy.add(event.properties.sessionID)
      return
    }
    if (event.type === "session.deleted") {
      this.wake.delete(event.properties.sessionID)
      this.parent.delete(event.properties.sessionID)
      this.stop(event.properties.sessionID)
      return
    }
    if (event.type !== "session.status" && event.type !== "session.idle" && event.type !== "session.error") return
    if (event.properties.sessionID) this.stop(event.properties.sessionID)
  }

  // An aborted or failed session may never get a reply event; a stale request
  // would otherwise make the session look stuck the next time it runs.
  private stop(id: string): void {
    this.busy.delete(id)
    for (const [request, session] of this.asked) if (session === id) this.asked.delete(request)
  }

  /**
   * True when no session is doing work the user would want to finish first.
   * A busy session with unknown ancestry counts as a root, which errs towards
   * staying awake.
   */
  settled(): boolean {
    if (this.wake.size > 0) return false
    const parents = new Set<string>()
    for (const id of this.busy) {
      const parent = this.parent.get(id)
      if (parent) parents.add(parent)
    }
    const waiting = new Set(this.asked.values())
    for (const id of this.busy) if (!parents.has(id) && !waiting.has(id)) return false
    return true
  }
}
