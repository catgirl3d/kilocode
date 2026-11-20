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
  cost: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
  }),
  time: Schema.Struct({ created: Schema.Number, completed: Schema.optional(Schema.Number) }),
})
export type BtwItem = Schema.Schema.Type<typeof BtwItem>
