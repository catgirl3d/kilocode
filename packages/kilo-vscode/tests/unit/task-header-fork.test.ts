import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("forks the current session from the chat header More actions menu", () => fixture("task-header-fork"), 30_000)
