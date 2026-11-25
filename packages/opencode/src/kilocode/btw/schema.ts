// fork_change - new file
import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const BtwStatus = Schema.Literals(["running", "done", "error", "cancelled", "interrupted"])
export type BtwStatus = Schema.Schema.Type<typeof BtwStatus>

export const BtwItem = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  threadID: Schema.String,
  status: BtwStatus,
  question: Schema.String,
  answer: Schema.String,
  error: Schema.optional(Schema.String),
  providerID: Schema.String,
  modelID: Schema.String,
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }),
  time: Schema.Struct({ created: Schema.Finite, completed: Schema.optional(Schema.Finite) }),
})
export type BtwItem = Schema.Schema.Type<typeof BtwItem>
