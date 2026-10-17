import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "protects advisor slot limits, locked moves and stored-value clamping",
  () => fixture("advisor-settings-slots-regression"),
  60_000,
)
