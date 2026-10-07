import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("keeps session-tag UI and provider state tied to confirmed host snapshots", () => fixture("session-tags-ui"), 30_000)
