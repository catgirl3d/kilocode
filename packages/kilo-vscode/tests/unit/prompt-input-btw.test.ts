import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("the prompt ask button and /btw line open the card, ask from its input, dictate from the card, follow up, insert, open history, and explain missing, blocked, editing, and recoverable connection states", async () => {
  await fixture("prompt-input-btw")
}, 120_000)
