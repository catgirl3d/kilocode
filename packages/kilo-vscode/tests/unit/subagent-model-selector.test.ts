import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "renders the subagent model quick selector and saves through the config scope",
  () => fixture("subagent-model-selector"),
  90_000,
)
