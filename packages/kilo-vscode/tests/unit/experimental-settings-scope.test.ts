import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("keeps the redact access keys switch personal and default on", () => fixture("experimental-settings-scope"), 60_000)
