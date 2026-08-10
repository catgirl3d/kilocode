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

describe("routeEarlyMessage background jobs", () => {
  it("forwards list request correlation", async () => {
    const calls: unknown[] = []
    const ctx = {
      backgroundJobs: async (sessionID: string, requestID: string) => calls.push([sessionID, requestID]),
    } as Ctx

    expect(
      await routeEarlyMessage({ type: "requestBackgroundJobs", sessionID: "ses_parent", requestID: "request-1" }, ctx),
    ).toBe(true)
    expect(calls).toEqual([["ses_parent", "request-1"]])
  })

  it("forwards cancellation through the owning parent session", async () => {
    const calls: unknown[] = []
    const ctx = {
      cancelBackgroundJob: async (jobID: string, sessionID: string, requestID: string) =>
        calls.push([jobID, sessionID, requestID]),
    } as Ctx

    expect(
      await routeEarlyMessage(
        {
          type: "cancelBackgroundJob",
          jobID: "ses_child",
          sessionID: "ses_parent",
          requestID: "request-2",
        },
        ctx,
      ),
    ).toBe(true)
    expect(calls).toEqual([["ses_child", "ses_parent", "request-2"]])
  })
})
