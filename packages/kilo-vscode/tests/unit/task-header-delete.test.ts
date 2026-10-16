import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("deletes the current session from the chat header More actions menu", () => fixture("task-header-delete"), 30_000)
