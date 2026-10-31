import { describe, it, expect } from "bun:test"
import { createRoot } from "solid-js"
import { createDeferredSends, type DeferredSendInput } from "../../webview-ui/src/context/session-deferred"
import type { DeferredSend } from "../../webview-ui/src/context/session-deferred"
import type { SessionStatus } from "../../webview-ui/src/types/messages"

const input = (sessionID: string, text: string): DeferredSendInput => ({
  sessionID,
  text,
  draft: text,
  preview: text,
})

const create = (statuses: Record<string, SessionStatus> = {}) => {
  const sent: DeferredSend[] = []
  let accept = true
  const value = createRoot((dispose) => {
    const deferred = createDeferredSends({
      status: (sessionID) => statuses[sessionID] ?? "idle",
      send: (item) => {
        if (!accept) return false
        sent.push(item)
        return true
      },
    })
    return { deferred, dispose }
  })
  return {
    ...value,
    sent,
    setAccept: (value: boolean) => {
      accept = value
    },
  }
}

describe("createDeferredSends", () => {
  it("does not flush an idle session before its turn closes", () => {
    const { deferred, sent, dispose } = create()
    deferred.add(input("a", "held"))

    deferred.flush("a")

    expect(sent).toEqual([])
    expect(deferred.list("a").map((item) => item.text)).toEqual(["held"])
    dispose()
  })

  it("does not flush a session that is busy after its turn closes", () => {
    const statuses = { a: "busy" as SessionStatus }
    const { deferred, sent, dispose } = create(statuses)
    deferred.add(input("a", "held"))

    deferred.turnClosed("a")
    deferred.flush("a")

    expect(sent).toEqual([])
    expect(deferred.list("a").map((item) => item.text)).toEqual(["held"])
    dispose()
  })

  it("sends the first item after close and idle while leaving the next queued", () => {
    const statuses = { a: "busy" as SessionStatus }
    const { deferred, sent, dispose } = create(statuses)
    deferred.add(input("a", "first"))
    deferred.add(input("a", "second"))

    deferred.turnClosed("a")
    statuses.a = "idle"
    deferred.flush("a")

    expect(sent.map((item) => item.text)).toEqual(["first"])
    expect(deferred.list("a").map((item) => item.text)).toEqual(["second"])
    dispose()
  })

  it("restores the item at the front when a closed idle send fails", () => {
    const { deferred, sent, setAccept, dispose } = create()
    setAccept(false)
    deferred.add(input("a", "first"))
    deferred.add(input("a", "second"))

    deferred.turnClosed("a")

    expect(sent).toEqual([])
    expect(deferred.list("a").map((item) => item.text)).toEqual(["first", "second"])
    dispose()
  })

  it("removes the store key when cancelling the last item", () => {
    const { deferred, dispose } = create()
    deferred.add(input("a", "first"))
    const item = deferred.list("a").at(0)
    expect(item).toBeDefined()

    deferred.cancel("a", item!.id)

    expect(deferred.list("a")).toEqual([])
    dispose()
  })

  it("removes the store key when taking all items", () => {
    const { deferred, dispose } = create()
    deferred.add(input("a", "first"))
    deferred.add(input("a", "second"))

    const taken = deferred.take("a")

    expect(taken.map((item) => item.text)).toEqual(["first", "second"])
    expect(deferred.list("a")).toEqual([])
    dispose()
  })

  it("removes the store key when clearing a session", () => {
    const { deferred, dispose } = create()
    deferred.add(input("a", "first"))
    deferred.add(input("b", "other"))

    deferred.clear("a")

    expect(deferred.list("a")).toEqual([])
    expect(deferred.list("b").map((item) => item.text)).toEqual(["other"])
    dispose()
  })

  it("releases an item immediately even while its session is busy", () => {
    const statuses = { a: "busy" as SessionStatus }
    const { deferred, sent, dispose } = create(statuses)
    deferred.add(input("a", "send now"))
    const item = deferred.list("a").at(0)
    expect(item).toBeDefined()

    deferred.release("a", item!.id)

    expect(sent.map((entry) => entry.text)).toEqual(["send now"])
    expect(deferred.list("a")).toEqual([])
    dispose()
  })

  it("restores a released item when the immediate send fails", () => {
    const { deferred, sent, setAccept, dispose } = create()
    setAccept(false)
    deferred.add(input("a", "send now"))
    const item = deferred.list("a").at(0)
    expect(item).toBeDefined()

    deferred.release("a", item!.id)

    expect(sent).toEqual([])
    expect(deferred.list("a").map((entry) => entry.text)).toEqual(["send now"])
    dispose()
  })

  it("clears the closed mark when a new turn becomes busy", () => {
    const statuses = { a: "busy" as SessionStatus }
    const { deferred, sent, dispose } = create(statuses)
    deferred.add(input("a", "held"))
    deferred.turnClosed("a")
    deferred.turnBusy("a")
    statuses.a = "idle"
    deferred.flush("a")

    expect(sent).toEqual([])
    expect(deferred.list("a").map((item) => item.text)).toEqual(["held"])
    dispose()
  })
})
