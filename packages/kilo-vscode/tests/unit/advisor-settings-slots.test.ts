import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("edits, validates, reorders and disables advisor slots in settings", () => fixture("advisor-settings-slots"), 60_000)
