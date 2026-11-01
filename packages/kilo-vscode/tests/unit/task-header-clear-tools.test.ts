import { describe, expect, it } from "bun:test"
import { createSessionTools, toolClearToast } from "../../webview-ui/src/context/session-tools"

function language() {
  return {
    locale: () => "en",
    t: (key: string) => key,
  } as never
}

function setup(opts: { connected?: boolean; current?: string } = {}) {
  const posted: Array<Record<string, unknown>> = []
  const actions = createSessionTools({
    isConnected: () => opts.connected ?? true,
    // A different current session keeps showToast (DOM) out of these state tests.
    currentSessionID: () => opts.current ?? "ses-other",
    post: (message: unknown) => posted.push(message as Record<string, unknown>),
    language: language(),
  })
  return { posted, actions }
}

function previewed(
  requestID: string,
  token: string,
  extra: Partial<{ turns: number; parts: number; tokens: number }> = {},
) {
  return {
    type: "sessionToolClearPreviewed" as const,
    sessionID: "ses-1",
    requestID,
    turns: extra.turns ?? 1,
    parts: extra.parts ?? 2,
    tokens: extra.tokens ?? 40,
    token,
  }
}

describe("session tool clear state", () => {
  it("builds a success toast with the cleared totals", () => {
    expect(
      toolClearToast(
        { type: "sessionToolCleared", sessionID: "ses-1", requestID: "apply-1", parts: 2, turns: 1, tokens: 40 },
        language(),
      ),
    ).toEqual({ variant: "success", title: "command.session.toolClear.success" })
  })

  it("requests a preview and stores the response for the matching request only", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 10)
    actions.preview("ses-1", 5)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({ type: "sessionToolClearPreview", sessionID: "ses-1", keepTurns: 5 })
    const first = posted[0]!.requestID as string
    const second = posted[1]!.requestID as string

    expect(actions.handleMessage(previewed(first, "old-token"))).toBe(true)
    expect(actions.state("ses-1").preview).toBeUndefined()
    expect(actions.state("ses-1").previewing).toBe(true)

    actions.handleMessage(previewed(second, "new-token", { turns: 3, parts: 9, tokens: 1200 }))
    expect(actions.state("ses-1")).toMatchObject({
      previewing: false,
      preview: { keepTurns: 5, turns: 3, parts: 9, tokens: 1200, token: "new-token" },
    })
    expect(actions.clearing("ses-1")).toBe(false)
  })

  it("dedupes delayed previews after the same preview completes", async () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 10)
    actions.handleMessage(previewed(posted[0]!.requestID as string, "token-1"))

    actions.preview("ses-1", 10, { delay: 20 })
    actions.preview("ses-1", 10, { delay: 20 })
    await Bun.sleep(50)
    expect(posted).toHaveLength(1)

    actions.preview("ses-1", 5, { delay: 20 })
    await Bun.sleep(50)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({ keepTurns: 5 })
  })

  it("cancels a pending delayed preview", async () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 7, { delay: 20 })
    actions.cancel("ses-1")
    await Bun.sleep(50)

    expect(posted).toHaveLength(0)
  })

  it("applies the previewed token and finishes on the cleared message", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 5)
    actions.handleMessage(previewed(posted[0]!.requestID as string, "token-5"))
    actions.apply("ses-1", 5, "token-5")

    expect(posted[1]).toMatchObject({ type: "sessionToolClear", sessionID: "ses-1", keepTurns: 5, token: "token-5" })
    expect(actions.state("ses-1")).toMatchObject({ applying: true, previewing: false })
    expect(actions.clearing("ses-1")).toBe(true)

    actions.handleMessage({
      type: "sessionToolCleared",
      sessionID: "ses-1",
      requestID: posted[1]!.requestID as string,
      parts: 2,
      turns: 1,
      tokens: 40,
    })
    expect(actions.state("ses-1").applying).toBe(false)
    expect(actions.state("ses-1").preview).toBeUndefined()
    expect(actions.state("ses-1").applied).toMatchObject({ parts: 2, turns: 1, tokens: 40 })
  })

  it("refuses to apply a preview made for a different keep-turns value", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 5)
    actions.handleMessage(previewed(posted[0]!.requestID as string, "token-5"))
    actions.apply("ses-1", 6, "token-5")

    expect(posted).toHaveLength(1)
    expect(actions.state("ses-1").error).toEqual({ code: "stale", message: "command.session.toolClear.stale" })
  })

  it("previews again when the backend reports a stale apply, keeping the stale notice", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 5)
    actions.handleMessage(previewed(posted[0]!.requestID as string, "token-5"))
    actions.apply("ses-1", 5, "token-5")
    actions.handleMessage({
      type: "sessionToolClearFailed",
      operation: "apply",
      sessionID: "ses-1",
      requestID: posted[1]!.requestID as string,
      code: "stale",
      error: "The tool-clear preview is stale.",
    })

    expect(posted).toHaveLength(3)
    expect(posted[2]).toMatchObject({ type: "sessionToolClearPreview", keepTurns: 5 })
    expect(actions.state("ses-1")).toMatchObject({ previewing: true, applying: false })
    expect(actions.state("ses-1").error?.code).toBe("stale")
  })

  it("surfaces backend messages for unknown failures and fixed text for known ones", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 5)
    actions.handleMessage({
      type: "sessionToolClearFailed",
      operation: "preview",
      sessionID: "ses-1",
      requestID: posted[0]!.requestID as string,
      code: "unknown",
      error: "  backend exploded  ",
    })
    expect(actions.state("ses-1").error).toEqual({ code: "unknown", message: "backend exploded" })

    actions.preview("ses-1", 5)
    actions.handleMessage({
      type: "sessionToolClearFailed",
      operation: "preview",
      sessionID: "ses-1",
      requestID: posted[1]!.requestID as string,
      code: "busy",
      error: "Session is busy: ses-1",
    })
    expect(actions.state("ses-1").error).toEqual({ code: "busy", message: "command.session.toolClear.error.busy" })
  })

  it("reports a missing connection without posting", () => {
    const { posted, actions } = setup({ connected: false })

    actions.preview("ses-1", 5)

    expect(posted).toHaveLength(0)
    expect(actions.state("ses-1").error?.code).toBe("notConnected")
    expect(actions.clearing("ses-1")).toBe(false)
  })

  it("drops a session's state when the session is deleted and lets the message through", () => {
    const { posted, actions } = setup()

    actions.preview("ses-1", 5)
    actions.handleMessage(previewed(posted[0]!.requestID as string, "token-5"))
    expect(actions.handleMessage({ type: "sessionDeleted", sessionID: "ses-1" })).toBe(false)

    expect(actions.state("ses-1").preview).toBeUndefined()
    expect(actions.state("ses-1").keepTurns).toBe(10)
  })

  it("ignores reasoning-clear messages", () => {
    const { actions } = setup()

    expect(
      actions.handleMessage({
        type: "sessionReasoningClearPreviewed",
        sessionID: "ses-1",
        requestID: "x",
        turns: 1,
        parts: 1,
        tokens: 1,
        unsupported: 0,
        token: "t",
      }),
    ).toBe(false)
  })
})
