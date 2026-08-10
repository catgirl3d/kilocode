import { describe, expect, it } from "bun:test"
import { routeEarlyMessage } from "../../src/kilo-provider/early-message"

type Ctx = Parameters<typeof routeEarlyMessage>[1]

function context(copied: string[], posted: unknown[], fail = false, shaken: string[] = []) {
  return {
    copy: async (text: string) => {
      if (fail) throw new Error("clipboard unavailable")
      copied.push(text)
    },
    post: (message: unknown) => posted.push(message),
    shake: async (sessionID: string) => shaken.push(sessionID),
  } as Ctx
}

describe("routeEarlyMessage clipboard handling", () => {
  it("routes clipboard text to the host", async () => {
    const copied: string[] = []
    const posted: unknown[] = []

    const handled = await routeEarlyMessage(
      { type: "copyToClipboard", id: "copy-1", text: "message text" },
      context(copied, posted),
    )

    expect(handled).toBe(true)
    expect(copied).toEqual(["message text"])
    expect(posted).toEqual([{ type: "clipboardWriteResult", id: "copy-1", ok: true }])
  })

  it("reports host clipboard failures", async () => {
    const copied: string[] = []
    const posted: unknown[] = []

    const handled = await routeEarlyMessage(
      { type: "copyToClipboard", id: "copy-2", text: "message text" },
      context(copied, posted, true),
    )

    expect(handled).toBe(true)
    expect(copied).toEqual([])
    expect(posted).toEqual([{ type: "clipboardWriteResult", id: "copy-2", ok: false, error: "clipboard unavailable" }])
  })

  it("dispatches manual session shake without routing it as a prompt", async () => {
    const shaken: string[] = []

    const handled = await routeEarlyMessage(
      { type: "shake", sessionID: "ses_shake" },
      context([], [], false, shaken),
    )

    expect(handled).toBe(true)
    expect(shaken).toEqual(["ses_shake"])
  })
})
