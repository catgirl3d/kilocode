import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("keeps no initial selection through live list refreshes", () => fixture("list-no-initial-selection-refresh"), 30_000)
