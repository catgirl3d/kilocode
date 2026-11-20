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

  it("shows a running answer with no thread or request set, as after a reload", () => {
    const { btw, dispose } = create()
    btw.handleMessage(updated({ id: "done", threadID: "t2", status: "done" }))
    expect(btw.current("s")).toEqual([])

    btw.handleMessage(updated({ id: "run", threadID: "t1" }))

    expect(btw.state("s").thread).toBeUndefined()
    expect(btw.current("s").map((entry) => entry.id)).toEqual(["run"])
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

  it("refuses a second ask while a side question runs and keeps the thread visible", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID, { threadID: "t1" }))
    const count = posted.length

    const sent = btw.ask("s", "again?")

    expect(sent).toBe(false)
    expect(posted.slice(count).map((message) => message.type)).toEqual(["btwHistory"])
    expect(btw.state("s").busy).toBe(true)
    expect(btw.state("s").thread).toBe("t1")
    expect(btw.state("s").request).toBeUndefined()
    expect(btw.current("s").map((entry) => entry.id)).toEqual(["b1"])

    btw.handleMessage(updated({ status: "done" }))
    expect(btw.ask("s", "again?")).toBe(true)
    expect(btw.state("s").busy).toBe(false)
    dispose()
  })

  it("refuses an ask while the start is pending and keeps the first request", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    const count = posted.length

    expect(btw.ask("s", "again?")).toBe(false)

    expect(posted.slice(count).map((message) => message.type)).toEqual(["btwHistory"])
    expect(btw.state("s").busy).toBe(true)
    expect(btw.state("s").request).toBe(requestID)
    expect(btw.state("s").open).toBe(true)
    dispose()
  })

  it("opens a closed card on a refused ask and asks the CLI for the list", () => {
    const { btw, posted, dispose } = create()
    btw.handleMessage(updated({ status: "running" }))
    expect(btw.state("s").open).toBe(false)

    expect(btw.ask("s", "again?")).toBe(false)

    expect(btw.state("s").open).toBe(true)
    expect(btw.state("s").busy).toBe(true)
    expect(btw.state("s").request).toBeUndefined()
    expect(posted.map((message) => message.type)).toEqual(["btwHistory"])
    dispose()
  })

  it("shows the thread again on a refused ask made from history", () => {
    const { btw, dispose } = create()
    btw.handleMessage(updated({ status: "running" }))
    btw.history("s")
    expect(btw.state("s").history).toBe(true)

    expect(btw.ask("s", "again?")).toBe(false)

    expect(btw.state("s").history).toBe(false)
    expect(btw.state("s").open).toBe(true)
    dispose()
  })

  it("asks for the list on a refused ask even while the card is open and shows the running thread", () => {
    const { btw, posted, dispose } = create()
    btw.handleMessage(updated({ id: "run", threadID: "t1" }))
    btw.open("s", "t9")
    const count = posted.length

    expect(btw.ask("s", "again?")).toBe(false)

    expect(posted.slice(count).map((message) => message.type)).toEqual(["btwHistory"])
    expect(btw.state("s").thread).toBe("t1")
    expect(btw.current("s").map((entry) => entry.id)).toEqual(["run"])
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

  it("hands a refused start back once with its thread", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    btw.handleMessage(started(asked(posted).requestID, { threadID: "t1" }))
    btw.handleMessage(updated({ status: "done" }))
    btw.follow("s")
    btw.ask("s", "and then?")
    const requestID = asked(posted).requestID

    btw.handleMessage({ type: "btwFailed", sessionID: "s", requestID, error: "busy" })

    expect(btw.take("s")).toEqual({ question: "and then?", thread: "t1" })
    expect(btw.take("s")).toBeUndefined()
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

  it("cancels only the side question it is given", () => {
    const { btw, posted, dispose } = create()
    btw.handleMessage(updated({ id: "old", time: { created: 1 } }))
    btw.handleMessage(updated({ id: "new", time: { created: 5 } }))

    btw.cancel("s", "old")
    expect(posted.at(-1)).toEqual({ type: "btwCancel", sessionID: "s", btwID: "old" })

    const count = posted.length
    btw.cancel("s")
    expect(posted.length).toBe(count)
    dispose()
  })

  it("close does not cancel a run another panel started", () => {
    const { btw, posted, dispose } = create()
    btw.handleMessage(updated({ id: "other" }))

    btw.close("s")

    expect(posted).toEqual([])
    expect(btw.running("s")).toBe(true)
    dispose()
  })

  it("cancels a start that arrives after the card closed and does not show it", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    btw.close("s")

    btw.handleMessage(started(requestID))

    expect(posted.at(-1)).toEqual({ type: "btwCancel", sessionID: "s", btwID: "b1" })
    expect(btw.state("s").items).toEqual([])
    expect(btw.state("s").request).toBeUndefined()
    dispose()
  })

  it("cancels a start superseded by a newer ask and shows the newer one", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "first?")
    const first = asked(posted).requestID
    btw.close("s")
    btw.ask("s", "second?")
    const second = asked(posted).requestID

    btw.handleMessage(started(first, { id: "first" }))
    expect(posted.at(-1)).toEqual({ type: "btwCancel", sessionID: "s", btwID: "first" })
    expect(btw.state("s").items).toEqual([])

    btw.handleMessage(started(second, { id: "second" }))
    expect(btw.state("s").items.map((entry) => entry.id)).toEqual(["second"])
    dispose()
  })

  it("does not cancel a superseded start that an update already finished", () => {
    const { btw, posted, dispose } = create()
    btw.ask("s", "why?")
    const requestID = asked(posted).requestID
    btw.close("s")
    const count = posted.length

    btw.handleMessage(updated({ status: "done" }))
    btw.handleMessage(started(requestID))

    expect(posted.slice(count).map((message) => message.type)).toEqual([])
    expect(btw.state("s").items.map((entry) => entry.status)).toEqual(["done"])
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

  it("refreshes the list only while an answer runs", () => {
    const { btw, posted, dispose } = create()
    btw.refresh("s")
    expect(posted).toEqual([])

    btw.handleMessage(updated({ id: "run" }))
    btw.refresh("s")
    expect(posted.at(-1)).toEqual({ type: "btwHistory", sessionID: "s" })

    const count = posted.length
    btw.handleMessage(updated({ id: "run", status: "done" }))
    btw.refresh("s")
    expect(posted.length).toBe(count)
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

  it("keeps only the newest 200 records per session", () => {
    const { btw, dispose } = create()
    const items = Array.from({ length: 205 }, (_, index) =>
      item({ id: `b${index}`, status: "done", time: { created: index } }),
    )

    btw.handleMessage({ type: "btwHistoryLoaded", sessionID: "s", items })
    expect(btw.state("s").items.length).toBe(200)
    expect(btw.state("s").items[0]?.id).toBe("b5")
    expect(btw.state("s").items.at(-1)?.id).toBe("b204")

    btw.handleMessage(updated({ id: "late", status: "done", time: { created: 1000 } }))
    expect(btw.state("s").items.length).toBe(200)
    expect(btw.state("s").items[0]?.id).toBe("b6")
    expect(btw.state("s").items.at(-1)?.id).toBe("late")
    dispose()
  })
})
