import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("keeps the active session row through live list refreshes", () => fixture("session-list-hover-refresh"), 30_000)
