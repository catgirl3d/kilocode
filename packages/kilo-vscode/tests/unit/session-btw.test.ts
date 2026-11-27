import { describe, it, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionBtw } from "../../webview-ui/src/context/session-btw"
import type { BtwItem, BtwAskRequest, ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

const item = (over: Partial<BtwItem> = {}): BtwItem => ({
  id: "b1",
  sessionID: "s",
  threadID: "t1",
  status: "running",
  question: "why?",
  answer: "",
  providerID: "p",
  modelID: "m",
  cost: 0,
  time: { created: 1 },
  ...over,
})

const asked = (posted: WebviewMessage[]): BtwAskRequest => {
  const message = posted.at(-1)
  if (message?.type !== "btwAsk") throw new Error("expected a btwAsk message")
  return message
}

const create = () => {
  const posted: WebviewMessage[] = []
  const usages: string[] = []
  const value = createRoot((dispose) => {
    const btw = createSessionBtw({
      post: (message) => {
        posted.push(message)
      },
      usage: (sessionID) => {
        usages.push(sessionID)
      },
    })
    return { btw, dispose }
  })
  return { ...value, posted, usages }
}

const started = (requestID: string, over: Partial<BtwItem> = {}): ExtensionMessage => ({
  type: "btwStarted",
  sessionID: "s",
  requestID,
  item: item(over),
})

const updated = (over: Partial<BtwItem> = {}): ExtensionMessage => ({
  type: "btwUpdated",
  sessionID: "s",
  item: item(over),
})

describe("createSessionBtw", () => {
  it("posts a fresh ask without a thread and opens the session", () => {
    const { btw, posted, dispose } = create()

    btw.ask("s", "why?")
    const first = asked(posted)
    btw.handleMessage(started(first.requestID))
    btw.handleMessage(updated({ status: "done" }))
    btw.ask("s", "again?")
    const second = asked(posted)

    expect(first.sessionID).toBe("s")
    expect(first.question).toBe("why?")
    expect(first.threadID).toBeUndefined()
    expect(first.requestID).not.toBe(second.requestID)
    expect(btw.state("s").open).toBe(true)
    expect(btw.state("s").request).toBe(second.requestID)
    dispose()
  })

  it("sets the thread from the matching start and ignores a stale start", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const ask = asked(posted)

    btw.handleMessage(started("stale", { id: "old", threadID: "old" }))
    expect(btw.state("s").thread).toBeUndefined()
    expect(btw.state("s").items).toEqual([])

    btw.handleMessage(started(ask.requestID))
    expect(btw.state("s").thread).toBe("t1")
    expect(btw.state("s").request).toBeUndefined()
    expect(btw.current("s").map((entry) => entry.id)).toEqual(["b1"])
    dispose()
  })

  it("keeps an update that arrived before the start response", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const ask = asked(posted)

    btw.handleMessage(updated({ status: "error", error: "boom" }))
    btw.handleMessage(started(ask.requestID))

    expect(btw.state("s").items.map((entry) => entry.status)).toEqual(["error"])
    expect(btw.state("s").thread).toBe("t1")
    dispose()
  })

  it("posts the current thread on a follow-up ask", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID, { threadID: "t1" }))
    btw.handleMessage(updated({ status: "done" }))

    btw.ask("s", "and then?", "t1")

    expect(asked(posted).threadID).toBe("t1")
    expect(btw.state("s").thread).toBe("t1")
    dispose()
  })

  it("drops the previous thread at once on a fresh ask", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID, { threadID: "t1" }))
    btw.handleMessage(updated({ status: "done" }))
    expect(btw.current("s").map((entry) => entry.id)).toEqual(["b1"])

    btw.ask("s", "unrelated?")

    expect(btw.state("s").thread).toBeUndefined()
    expect(btw.current("s")).toEqual([])
    expect(btw.state("s").request).toBe(asked(posted).requestID)
    dispose()
  })

  it("reports busy while a start is pending or an answer runs", () => {
    const { btw, posted, dispose } = create()

    btw.ask("s", "why?")
    expect(btw.busy("s")).toBe(true)

    btw.handleMessage(started(asked(posted).requestID))
    expect(btw.busy("s")).toBe(true)

    btw.handleMessage(updated({ status: "done" }))
    expect(btw.busy("s")).toBe(false)
    dispose()
  })

  it("offers a refused question back to the card", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID: asked(posted).requestID, error: "busy" })
    expect(btw.state("s").retry).toBe("why?")
    expect(btw.state("s").asked).toBeUndefined()
    expect(btw.state("s").request).toBeUndefined()

    btw.ask("s", "again?")
    expect(btw.state("s").retry).toBeUndefined()

    btw.handleMessage({ type: "btwFailed", sessionID: "s", error: "history failed" })
    expect(btw.state("s").retry).toBeUndefined()

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID: asked(posted).requestID, error: "busy" })
    expect(btw.state("s").retry).toBe("again?")

    btw.close("s")
    expect(btw.state("s").retry).toBeUndefined()

    btw.ask("s", "final?")
    expect(btw.state("s").asked).toBe("final?")
    btw.handleMessage(started(asked(posted).requestID))
    expect(btw.state("s").asked).toBeUndefined()
    dispose()
  })

  it("compose bumps the focus counter on every call", () => {
    const { btw, dispose } = create()

    btw.compose("s")
    btw.compose("s")
    expect(btw.state("s").focus).toBe(2)
    expect(btw.state("s").open).toBe(true)

    btw.ask("s", "why?")
    expect(btw.state("s").focus).toBe(0)

    btw.close("s")
    expect(btw.state("s").focus).toBe(0)
    dispose()
  })

  it("shown returns the thread only while the card displays it", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID))

    expect(btw.shown("s")).toBe("t1")

    btw.history("s")
    expect(btw.shown("s")).toBeUndefined()

    btw.open("s", "t1")
    expect(btw.shown("s")).toBe("t1")

    btw.close("s")
    expect(btw.shown("s")).toBeUndefined()
    dispose()
  })

  it("fresh leaves the shown thread without posting", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID))
    expect(btw.shown("s")).toBe("t1")

    const before = posted.length
    btw.fresh("s")

    expect(btw.state("s").thread).toBeUndefined()
    expect(btw.state("s").open).toBe(true)
    expect(btw.state("s").history).toBe(false)
    expect(btw.state("s").focus).toBe(1)
    expect(posted.length).toBe(before)

    btw.history("s")
    btw.fresh("s")

    expect(btw.state("s").history).toBe(false)
    expect(btw.state("s").focus).toBe(1)
    dispose()
  })

  it("upserts updates by id and reports a terminal status to usage once", () => {
    const { btw, usages, dispose } = create()

    btw.handleMessage(updated({ answer: "a" }))
    btw.handleMessage(updated({ answer: "ab" }))
    expect(btw.state("s").items.map((entry) => entry.answer)).toEqual(["ab"])
    expect(usages).toEqual([])

    btw.handleMessage(updated({ status: "done", answer: "abc", cost: 0.01 }))
    btw.handleMessage(updated({ status: "done", answer: "abc", cost: 0.01 }))

    expect(btw.state("s").items.map((entry) => entry.status)).toEqual(["done"])
    expect(btw.state("s").items[0]?.answer).toBe("abc")
    expect(usages).toEqual(["s"])
    dispose()
  })

  it("cancels the running answer and resets the view on close", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID))

    btw.close("s")

    expect(posted.at(-1)).toEqual({ type: "btwCancel", sessionID: "s", btwID: "b1" })
    expect(btw.state("s").open).toBe(false)
    expect(btw.state("s").thread).toBeUndefined()
    dispose()
  })

  it("merges loaded history sorted by creation time and marks it loaded", () => {
    const { btw, dispose } = create()
    btw.handleMessage(updated({ id: "live", status: "done", time: { created: 30 } }))

    btw.handleMessage({
      type: "btwHistoryLoaded",
      sessionID: "s",
      items: [
        item({ id: "b", status: "done", time: { created: 20 } }),
        item({ id: "a", status: "done", time: { created: 10 } }),
        item({ id: "live", status: "done", time: { created: 30 }, answer: "new" }),
      ],
    })

    expect(btw.state("s").items.map((entry) => entry.id)).toEqual(["a", "b", "live"])
    expect(btw.state("s").items[2]?.answer).toBe("new")
    expect(btw.state("s").loaded).toBe(true)
    dispose()
  })

  it("drops the session state on delete and lets the handler continue", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID))

    const handled = btw.handleMessage({ type: "sessionDeleted", sessionID: "s" })

    expect(handled).toBe(false)
    expect(btw.state("s").items).toEqual([])
    expect(btw.state("s").open).toBe(false)
    dispose()
  })

  it("clears the pending request only for a failure that names it", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID

    btw.handleMessage({ type: "btwFailed", sessionID: "s", error: "history failed" })
    expect(btw.state("s").request).toBe(requestID)
    expect(btw.state("s").error).toBe("history failed")

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID: "stale", error: "old" })
    expect(btw.state("s").request).toBe(requestID)
    expect(btw.state("s").error).toBe("history failed")

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID, error: "busy" })
    expect(btw.state("s").request).toBeUndefined()
    expect(btw.state("s").error).toBe("busy")
    dispose()
  })

  it("never replaces a terminal record with a running copy", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(updated({ status: "done", answer: "abc" }))

    btw.handleMessage(started(asked(posted).requestID, { answer: "a" }))
    btw.handleMessage(updated({ answer: "abcdef" }))
    btw.handleMessage({ type: "btwHistoryLoaded", sessionID: "s", items: [item({ answer: "x" })] })

    expect(btw.state("s").items.map((entry) => [entry.status, entry.answer])).toEqual([["done", "abc"]])
    dispose()
  })

  it("keeps the longer answer while both copies are running", () => {
    const { btw, dispose } = create()
    btw.handleMessage(updated({ answer: "abc" }))
    btw.handleMessage(updated({ answer: "a" }))
    expect(btw.state("s").items[0]?.answer).toBe("abc")

    btw.handleMessage(updated({ answer: "abcd" }))
    expect(btw.state("s").items[0]?.answer).toBe("abcd")
    dispose()
  })

  it("requests the list once per closed-to-open transition", () => {
    const { btw, posted, dispose } = create()
    const kinds = () => posted.map((message) => message.type)

    btw.ask("s", "why?")
    expect(kinds()).toEqual(["btwHistory", "btwAsk"])

    btw.handleMessage(started(asked(posted).requestID))
    btw.handleMessage(updated({ status: "done" }))
    btw.ask("s", "next?")
    expect(kinds()).toEqual(["btwHistory", "btwAsk", "btwAsk"])

    btw.close("s")
    btw.history("s")
    btw.open("s", "t1")
    btw.open("s", "t2")
    expect(kinds()).toEqual(["btwHistory", "btwAsk", "btwAsk", "btwHistory"])
    dispose()
  })

  it("cancels the latest running side question", () => {
    const { btw, posted, dispose } = create()
    btw.handleMessage(updated({ id: "old", time: { created: 1 } }))
    btw.handleMessage(updated({ id: "new", time: { created: 5 } }))

    btw.cancel("s")

    expect(posted.at(-1)).toEqual({ type: "btwCancel", sessionID: "s", btwID: "new" })
    dispose()
  })

  it("cancels a start that arrives after the card was closed", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    btw.close("s")
    posted.length = 0

    btw.handleMessage(started(requestID, { id: "late", threadID: "late" }))

    expect(posted).toEqual([{ type: "btwCancel", sessionID: "s", btwID: "late" }])
    expect(btw.state("s").thread).toBeUndefined()
    expect(btw.state("s").items).toEqual([])

    btw.ask("other", "other?")
    expect(btw.state("other").abandoned).toEqual([])
    dispose()
  })

  it("cancels only the abandoned start, not a new side question", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "first?")
    const first = asked(posted).requestID
    btw.close("s")
    btw.ask("s", "second?")
    const second = asked(posted).requestID
    posted.length = 0

    btw.handleMessage(started(first, { id: "old", threadID: "old" }))
    expect(posted).toEqual([{ type: "btwCancel", sessionID: "s", btwID: "old" }])
    expect(btw.state("s").request).toBe(second)

    btw.handleMessage(started(second, { id: "new", threadID: "new" }))
    expect(posted).toEqual([{ type: "btwCancel", sessionID: "s", btwID: "old" }])
    expect(btw.state("s").request).toBeUndefined()
    expect(btw.state("s").thread).toBe("new")
    expect(btw.state("s").items.map((entry) => entry.id)).toEqual(["new"])
    dispose()
  })

  it("forgets an abandoned request that failed before it started", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    btw.close("s")
    posted.length = 0

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID, error: "busy" })
    expect(btw.state("s").abandoned).toEqual([])

    btw.handleMessage(started(requestID, { id: "late" }))
    expect(posted).toEqual([])
    dispose()
  })

  it("clears a stale error when a thread is opened or history is requested", () => {
    const { btw, dispose } = create()
    btw.handleMessage({ type: "btwFailed", sessionID: "s", error: "history failed" })

    btw.open("s", "t1")
    expect(btw.state("s").error).toBeUndefined()

    btw.handleMessage({ type: "btwFailed", sessionID: "s", error: "history failed" })
    btw.history("s")
    expect(btw.state("s").error).toBeUndefined()
    dispose()
  })

  it("adds the session's side-question spend to the cost breakdown", () => {
    const { btw, dispose } = create()
    const items = [{ label: "This session", cost: 1 }]
    expect(btw.breakdown("s", items, "Side questions")).toBe(items)

    btw.handleMessage(updated({ id: "a", status: "done", cost: 0.25 }))
    btw.handleMessage(updated({ id: "b", status: "done", cost: 0.5, time: { created: 2 } }))

    expect(btw.breakdown("s", items, "Side questions")).toEqual([...items, { label: "Side questions", cost: 0.75 }])
    dispose()
  })
})
