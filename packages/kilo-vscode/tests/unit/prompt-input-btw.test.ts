import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("the /btw prompt asks, follows up, inserts, opens history, and explains missing or blocked sessions", async () => {
  await fixture("prompt-input-btw")
}, 120_000)
