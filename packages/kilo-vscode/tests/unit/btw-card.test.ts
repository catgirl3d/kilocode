import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("the side-question card cancels, follows up, inserts, copies, opens history, and shows failures", async () => {
  await fixture("btw-card")
}, 120_000)
