import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("reverts to an answered question without touching the composer, and counts the reverted messages", () =>
  fixture("question-revert"))
