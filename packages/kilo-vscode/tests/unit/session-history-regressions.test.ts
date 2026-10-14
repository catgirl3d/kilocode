import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "keeps history root/scope/tag projections and favorite rows independently pending",
  () => fixture("session-history-regressions"),
  30_000,
)
