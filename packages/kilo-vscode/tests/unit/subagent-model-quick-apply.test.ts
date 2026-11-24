import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "applies quick subagent model writes and settles their busy state",
  () => fixture("subagent-model-quick-apply"),
  60_000,
)
