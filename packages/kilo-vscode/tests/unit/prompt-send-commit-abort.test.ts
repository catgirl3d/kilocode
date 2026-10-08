import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("aborts a prompt send when git commit context fails and allows a successful retry", async () => {
  const prev = process.env.PROMPT_INPUT_COMMIT_ABORT
  process.env.PROMPT_INPUT_COMMIT_ABORT = "1"
  try {
    await fixture("prompt-input-send")
  } finally {
    if (prev === undefined) delete process.env.PROMPT_INPUT_COMMIT_ABORT
    if (prev !== undefined) process.env.PROMPT_INPUT_COMMIT_ABORT = prev
  }
}, 30_000)
