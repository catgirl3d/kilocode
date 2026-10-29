import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "converts a read-only sub-agent session from the chat header More actions menu",
  () => fixture("task-header-convert"),
  30_000,
)
