import { describe, expect, test } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2"
import type { DialogContext } from "@tui/ui/dialog"
import type { ToastContext } from "@tui/ui/toast"
import { arm, take } from "@/kilocode/cli/cmd/tui/btw-command"
import { BtwPrompt } from "@/kilocode/cli/cmd/tui/component/btw-prompt"

const client = {} as unknown as KiloClient
const toast = { show() {} } as unknown as ToastContext
const dialog = { replace() {} } as unknown as DialogContext

function submit(input: { text: string; sessionID: string; skip?: boolean }) {
  return BtwPrompt.run({ ...input, client, toast, dialog, done() {} })
}

describe("btw prompt arming", () => {
  test("a non-btw submit drops the armed follow-up", async () => {
    arm("ses_btw_plain", "btw_plain")
    expect(await submit({ text: "refactor the parser", sessionID: "ses_btw_plain" })).toBe(false)
    expect(take("ses_btw_plain")).toBeUndefined()
  })

  test("a skipped submit keeps the armed follow-up", async () => {
    arm("ses_btw_skip", "btw_skip")
    expect(await submit({ text: "refactor the parser", sessionID: "ses_btw_skip", skip: true })).toBe(false)
    expect(take("ses_btw_skip")).toBe("btw_skip")
  })

  test("opening history drops the armed follow-up", async () => {
    arm("ses_btw_history", "btw_history")
    expect(await submit({ text: "/btw", sessionID: "ses_btw_history" })).toBe(true)
    expect(take("ses_btw_history")).toBeUndefined()
  })
})
