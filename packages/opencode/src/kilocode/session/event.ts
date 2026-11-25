import { BusEvent } from "@/bus/bus-event"
import { BtwItem } from "@/kilocode/btw/schema" // fork_change
import { MessageID, SessionID } from "@/session/schema"
import { Schema } from "effect"

// "superseded": the turn handed off to a queued follow-up after draining its
// current step. Distinct from "interrupted" so clients do not surface a
// premature-stop warning for a deliberate queue handoff.
const CloseReason = Schema.Literals(["completed", "error", "interrupted", "superseded"])

export const KiloSessionEvent = {
  TurnOpen: BusEvent.define(
    "session.turn.open",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
  TurnClose: BusEvent.define(
    "session.turn.close",
    Schema.Struct({
      sessionID: SessionID,
      parentID: Schema.optional(SessionID),
      reason: CloseReason,
    }),
  ),
  // FIFO snapshot of queued (waiting, not-yet-running)
  // user message IDs per session, for remote clients (mobile) to show
  // "Queued" badges. The currently-running turn's own message is not included.
  QueueChanged: BusEvent.define(
    "session.queue.changed",
    Schema.Struct({
      sessionID: SessionID,
      queued: Schema.Array(MessageID),
    }),
  ),
  // fork_change start
  // Side question (/btw) record snapshot: published on start, throttled while
  // streaming, and on completion. Clients upsert by item.id. Never persisted.
  BtwUpdated: BusEvent.define(
    "session.btw.updated",
    Schema.Struct({
      sessionID: SessionID,
      item: BtwItem,
    }),
  ),
  // fork_change end
}

export type KiloSessionCloseReason = Schema.Schema.Type<typeof CloseReason>
