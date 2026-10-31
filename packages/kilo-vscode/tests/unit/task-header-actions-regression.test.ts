import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it(
  "covers delete and reasoning clear actions through the real session context",
  () => fixture("task-header-actions-regression"),
  60_000,
)
