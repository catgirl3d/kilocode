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

    btw.follow("s")
    btw.ask("s", "and then?")

    expect(asked(posted).threadID).toBe("t1")
    expect(btw.state("s").follow).toBe(false)
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

  it("leaves follow-up mode when a thread is opened from history", () => {
    const { btw, dispose } = create()
    btw.follow("s")

    btw.open("s", "t2")

    expect(btw.state("s").follow).toBe(false)
    expect(btw.state("s").thread).toBe("t2")
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

  it("ignores a start that arrives after the card closed", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    btw.close("s")
    const count = posted.length

    btw.handleMessage(started(requestID))

    expect(posted.length).toBe(count)
    expect(btw.state("s").items).toEqual([])
    expect(btw.state("s").request).toBeUndefined()
    dispose()
  })

  it("ignores a start superseded by a newer ask and shows the newer one", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "first?")
    const first = asked(posted).requestID
    btw.close("s")
    btw.ask("s", "second?")
    const second = asked(posted).requestID

    btw.handleMessage(started(first, { id: "first" }))
    expect(posted.at(-1)?.type).toBe("btwAsk")
    expect(btw.state("s").items).toEqual([])

    btw.handleMessage(started(second, { id: "second" }))
    expect(btw.state("s").items.map((entry) => entry.id)).toEqual(["second"])
    dispose()
  })

  it("stops following a thread after unfollow", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID, { threadID: "t1" }))
    btw.handleMessage(updated({ status: "done" }))
    btw.follow("s")

    btw.unfollow("s")
    expect(btw.state("s").follow).toBe(false)

    btw.ask("s", "unrelated?")
    expect(asked(posted).threadID).toBeUndefined()
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
