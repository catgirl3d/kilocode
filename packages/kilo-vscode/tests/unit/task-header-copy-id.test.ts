import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("copies the current session id from the chat header More actions menu", () => fixture("task-header-copy-id"), 30_000)
