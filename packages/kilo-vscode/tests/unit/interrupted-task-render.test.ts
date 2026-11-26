import { expect, it } from "bun:test"
import { fixture } from "../fixtures/run"

it("keeps the subagent card when a running task is interrupted", async () => {
  await fixture("interrupted-task-render")
}, 60_000)
