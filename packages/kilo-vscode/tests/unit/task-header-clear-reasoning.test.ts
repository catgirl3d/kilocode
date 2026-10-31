import { describe, expect, it } from "bun:test"
import {
  createSessionReasoning,
  previewStale,
  reasoningClearToast,
  shouldCloseReasoningDialog,
} from "../../webview-ui/src/context/session-reasoning"

function language() {
  return {
    locale: () => "en",
    t: (key: string) => key,
  } as never
}

function english() {
  return {
    locale: () => "en",
    t: (key: string) => (key === "command.session.reasoningClear.stale" ? "Context changed, preview again." : key),
  } as never
}

function item(keepTurns: number) {
  return {
    keepTurns,
    turns: 1,
    parts: 2,
    tokens: 40,
    unsupported: 0,
    token: "token-1",
  }
}

describe("session reasoning clear state", () => {
  it("shows a success toast with the cleared totals", () => {
    expect(
      reasoningClearToast(
        {
          type: "sessionReasoningCleared",
          sessionID: "ses-1",
          requestID: "apply-1",
          parts: 2,
          turns: 1,
          tokens: 40,
        },
        language(),
      ),
    ).toEqual({ variant: "success", title: "command.session.reasoningClear.success" })
  })

  it("ignores late preview responses after a newer keep-turns request", () => {
    const posted: unknown[] = []
    let current = "ses-1"
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => current,
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    actions.preview("ses-1", 5)
    const first = posted[0] as { requestID: string }
    const second = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: first.requestID,
      turns: 2,
      parts: 3,
      tokens: 88,
      unsupported: 0,
      token: "old-token",
    })
    expect(actions.state("ses-1").preview).toBeUndefined()

    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: second.requestID,
      turns: 1,
      parts: 1,
      tokens: 20,
      unsupported: 0,
      token: "new-token",
    })
    expect(actions.state("ses-1").preview?.token).toBe("new-token")
    current = "ses-2"
    expect(actions.state("ses-1").preview?.token).toBe("new-token")
  })

  it("dedupes delayed previews after the same preview completes", async () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const first = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: first.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })

    actions.preview("ses-1", 10, { delay: 20 })
    actions.preview("ses-1", 10, { delay: 20 })
    await Bun.sleep(50)
    expect(posted).toHaveLength(1)

    actions.preview("ses-1", 5, { delay: 20 })
    await Bun.sleep(50)

    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 5,
    })
  })

  it("cancels a pending delayed preview", async () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 5, { delay: 20 })
    actions.cancel("ses-1")
    await Bun.sleep(50)

    expect(posted).toHaveLength(0)
    expect(actions.clearing("ses-1")).toBe(false)
  })

  it("refreshes an immediate preview after the same preview completes", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const request = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: request.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })

    actions.preview("ses-1", 10)

    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 10,
    })
  })

  it("marks only mismatched preview keep-turns as stale", () => {
    expect(previewStale(undefined, 10)).toBe(false)
    expect(previewStale(item(10), 10)).toBe(false)
    expect(previewStale(item(10), 5)).toBe(true)
  })

  it("rejects stale apply tokens and accepts the matching keep-turns value", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: english(),
    })

    actions.preview("ses-1", 10)
    const request = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: request.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })

    actions.apply("ses-1", 5, "token-1")

    expect(posted).toHaveLength(1)
    expect(actions.state("ses-1").applying).toBe(false)
    expect(actions.state("ses-1").error?.message).toBe("Context changed, preview again.")

    actions.apply("ses-1", 10, "token-1")

    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({
      type: "sessionReasoningClear",
      keepTurns: 10,
      token: "token-1",
    })
  })

  it("posts a preview when keep-turns changes", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const request = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: request.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })

    actions.preview("ses-1", 5)

    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 5,
    })
  })

  it("retries the same preview after a preview error", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const request = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearFailed",
      operation: "preview",
      sessionID: "ses-1",
      requestID: request.requestID,
      code: "busy",
      error: "Session is busy",
    })

    expect(actions.state("ses-1").preview).toBeUndefined()
    expect(actions.state("ses-1").previewing).toBe(false)

    actions.preview("ses-1", 10)

    expect(posted).toHaveLength(2)
    expect(posted[1]).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 10,
    })
  })

  it("debounces delayed previews and posts only the latest keep-turns value", async () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10, { delay: 20 })
    actions.preview("ses-1", 5, { delay: 20 })
    expect(posted).toHaveLength(0)

    await Bun.sleep(50)

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 5,
    })
  })

  it("does not let a preview interrupt an active apply", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.apply("ses-1", 10, "token-1")
    actions.preview("ses-1", 10, { delay: 0 })

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ type: "sessionReasoningClear" })
    expect(actions.state("ses-1").applying).toBe(true)
  })

  it("reports an active apply as clearing until the server confirms it", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")

    expect(actions.clearing("ses-1")).toBe(true)

    const apply = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningCleared",
      sessionID: "ses-1",
      requestID: apply.requestID,
      parts: 2,
      turns: 1,
      tokens: 40,
    })

    expect(actions.clearing("ses-1")).toBe(false)
  })

  it("posts exactly one apply request with the preview token and keeps localized failures visible", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")
    expect(posted.at(-1)).toEqual({
      type: "sessionReasoningClear",
      sessionID: "ses-1",
      requestID: expect.any(String),
      keepTurns: 10,
      token: "token-1",
    })
    expect(posted.filter((message) => (message as { type: string }).type === "sessionReasoningClear")).toHaveLength(1)

    const requestID = (posted.at(-1) as { requestID: string }).requestID
    actions.handleMessage({
      type: "sessionReasoningClearFailed",
      operation: "apply",
      sessionID: "ses-1",
      requestID,
      code: "busy",
      error: "Session is busy",
    })
    expect(actions.state("ses-1").error?.message).toBe("command.session.reasoningClear.error.busy")
    expect(actions.state("ses-1").applying).toBe(false)
    expect(shouldCloseReasoningDialog(true, actions.state("ses-1"))).toBe(false)
  })

  it("shows the server message for an unknown apply failure and allows a subsequent preview", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")
    const apply = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearFailed",
      operation: "apply",
      sessionID: "ses-1",
      requestID: apply.requestID,
      code: "unknown",
      error: "The server returned an unexpected response",
    })

    expect(actions.state("ses-1").error?.message).toBe("The server returned an unexpected response")
    expect(actions.state("ses-1").applying).toBe(false)
    expect(shouldCloseReasoningDialog(true, actions.state("ses-1"))).toBe(false)

    actions.preview("ses-1", 5)
    expect(posted.at(-1)).toEqual({
      type: "sessionReasoningClearPreview",
      sessionID: "ses-1",
      requestID: expect.any(String),
      keepTurns: 5,
    })
  })

  it("shows the server message for a conflict apply failure", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: english(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")
    const apply = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearFailed",
      operation: "apply",
      sessionID: "ses-1",
      requestID: apply.requestID,
      code: "conflict",
      error: "The session changed on the server.",
    })

    expect(actions.state("ses-1").error?.message).toBe("The session changed on the server.")
  })

  it("maps every reasoning clear error code to its localized key", () => {
    const cases = [
      ["busy", "command.session.reasoningClear.error.busy"],
      ["conflict", "command.session.reasoningClear.error.conflict"],
      ["notFound", "command.session.reasoningClear.error.notFound"],
      ["notConnected", "command.session.reasoningClear.error.notConnected"],
      ["invalid", "command.session.reasoningClear.error.invalid"],
      ["unknown", "command.session.reasoningClear.error.unknown"],
    ] as const

    for (const [code, expected] of cases) {
      const posted: unknown[] = []
      const actions = createSessionReasoning({
        isConnected: () => code !== "notConnected",
        currentSessionID: () => "ses-1",
        post: (message) => posted.push(message),
        language: language(),
      })

      if (code === "notConnected") {
        actions.preview("ses-1", 10)
      } else {
        actions.preview("ses-1", 10)
        const request = posted[0] as { requestID: string }
        actions.handleMessage({
          type: "sessionReasoningClearFailed",
          operation: "preview",
          sessionID: "ses-1",
          requestID: request.requestID,
          code,
          error: "",
        })
      }

      expect(actions.state("ses-1").error?.message).toBe(expected)
    }
  })

  it("records a successful apply and closes only after the applied message arrives", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")
    const applied = {
      type: "sessionReasoningCleared" as const,
      sessionID: "ses-1",
      requestID: (posted[1] as { requestID: string }).requestID,
      parts: 2,
      turns: 1,
      tokens: 40,
    }
    actions.handleMessage(applied)

    expect(actions.state("ses-1").applied).toEqual(applied)
    expect(shouldCloseReasoningDialog(true, actions.state("ses-1"))).toBe(true)

    const before = posted.length
    actions.preview("ses-1", 10)
    expect(posted).toHaveLength(before + 1)
    expect(posted.at(-1)).toMatchObject({
      type: "sessionReasoningClearPreview",
      keepTurns: 10,
    })
    expect(actions.state("ses-1").applied).toBeUndefined()
  })

  it("cancels a delayed preview when apply starts", async () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })
    actions.preview("ses-1", 10, { delay: 20 })
    actions.apply("ses-1", 10, "token-1")

    const apply = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningCleared",
      sessionID: "ses-1",
      requestID: apply.requestID,
      parts: 2,
      turns: 1,
      tokens: 40,
    })
    await Bun.sleep(50)

    expect(posted).toHaveLength(2)
    expect(actions.state("ses-1").applied).toBeDefined()
    expect(actions.state("ses-1").preview).toBeUndefined()
  })

  it("cancels a delayed preview when the session is deleted", async () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10, { delay: 20 })
    actions.handleMessage({ type: "sessionDeleted", sessionID: "ses-1" })
    await Bun.sleep(50)

    expect(posted).toHaveLength(0)
  })

  it("drops all reasoning state when the session is deleted", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 5)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 2,
      tokens: 40,
      unsupported: 0,
      token: "token-1",
    })

    expect(actions.state("ses-1").keepTurns).toBe(5)

    actions.handleMessage({ type: "sessionDeleted", sessionID: "ses-1" })

    expect(actions.state("ses-1").preview).toBeUndefined()
    expect(actions.state("ses-1").keepTurns).toBe(10)
  })

  it("re-previews after a stale apply without issuing a second apply", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const preview = posted[0] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: preview.requestID,
      turns: 1,
      parts: 1,
      tokens: 20,
      unsupported: 0,
      token: "token-1",
    })
    actions.apply("ses-1", 10, "token-1")
    const apply = posted[1] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearFailed",
      operation: "apply",
      sessionID: "ses-1",
      requestID: apply.requestID,
      code: "stale",
      error: "The reasoning-clear preview is stale. Preview again before clearing.",
    })

    expect(posted).toHaveLength(3)
    expect(posted[2]).toEqual({
      type: "sessionReasoningClearPreview",
      sessionID: "ses-1",
      requestID: expect.any(String),
      keepTurns: 10,
    })
    expect(actions.state("ses-1").error?.message).toBe("command.session.reasoningClear.stale")
    expect(actions.state("ses-1").applied).toBeUndefined()
    expect(shouldCloseReasoningDialog(true, actions.state("ses-1"))).toBe(false)

    const repreview = posted[2] as { requestID: string }
    actions.handleMessage({
      type: "sessionReasoningClearPreviewed",
      sessionID: "ses-1",
      requestID: repreview.requestID,
      turns: 1,
      parts: 1,
      tokens: 20,
      unsupported: 0,
      token: "token-2",
    })
    expect(actions.state("ses-1").preview?.token).toBe("token-2")
    expect(actions.state("ses-1").error?.message).toBe("command.session.reasoningClear.stale")

    actions.preview("ses-1", 5)
    expect(actions.state("ses-1").error).toBeUndefined()
  })

  it("does not close the dialog before a submitted apply has an applied result", () => {
    const state = {
      keepTurns: 10,
      previewing: false,
      applying: false,
      requestID: undefined,
      error: undefined,
    }

    expect(shouldCloseReasoningDialog(false, state)).toBe(false)
    expect(shouldCloseReasoningDialog(true, state)).toBe(false)
  })

  it("does not post an apply request when the dialog is cancelled", () => {
    const posted: unknown[] = []
    const actions = createSessionReasoning({
      isConnected: () => true,
      currentSessionID: () => "ses-1",
      post: (message) => posted.push(message),
      language: language(),
    })

    actions.preview("ses-1", 10)
    const before = [...posted]

    expect(shouldCloseReasoningDialog(false, actions.state("ses-1"))).toBe(false)
    expect(posted).toEqual(before)
    expect(posted.filter((message) => (message as { type: string }).type === "sessionReasoningClear")).toHaveLength(0)
  })
})
