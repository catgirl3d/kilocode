import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("selects several sessions and deletes them through the bulk action", () => fixture("session-list-selection"), 30_000)
