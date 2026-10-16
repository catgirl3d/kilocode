import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "deletes the current session from the chat header through the real session context",
  () => fixture("task-header-delete-regression"),
  60_000,
)
