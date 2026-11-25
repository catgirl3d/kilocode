import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { KiloProviderBtw } from "../../src/kilo-provider/btw"

const item = {
  id: "btw_1",
  sessionID: "ses_1",
  threadID: "btw_1",
  status: "running",
  question: "why?",
  answer: "",
  providerID: "kilo",
  modelID: "test",
  cost: 0,
  time: { created: 1 },
}

function subject(client: KiloClient | undefined) {
  const posts: unknown[] = []
  const btw = new KiloProviderBtw({
    client: () => client,
    dir: () => "/repo",
    post: (message) => posts.push(message),
  })
  return { btw, posts }
}

describe("KiloProviderBtw", () => {
  it("asks in the session directory with the trimmed question and posts the started item", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btw: async (input: unknown, options: unknown) => {
          calls.push([input, options])
          return { data: item }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwAsk", sessionID: "ses_1", requestID: "req_1", question: "  why?  " })

    expect(calls).toEqual([
      [{ sessionID: "ses_1", directory: "/repo", question: "why?", threadID: undefined }, { throwOnError: true }],
    ])
    expect(posts).toEqual([{ type: "btwStarted", sessionID: "ses_1", requestID: "req_1", item }])
  })

  it("ignores an ask without a request ID", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btw: async (input: unknown) => {
          calls.push(input)
          return { data: item }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwAsk", sessionID: "ses_1", question: "why?" })

    expect(calls).toEqual([])
    expect(posts).toEqual([])
  })

  it("ignores an ask without a session ID", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btw: async (input: unknown) => {
          calls.push(input)
          return { data: item }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwAsk", requestID: "req_1", question: "why?" })

    expect(calls).toEqual([])
    expect(posts).toEqual([])
  })

  it("posts the server message when a side question request is rejected", async () => {
    const { btw, posts } = subject({
      session: {
        btw: async () => {
          throw new Error("A side question is already running")
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwAsk", sessionID: "ses_1", requestID: "req_1", question: "why?" })

    expect(posts).toEqual([
      {
        type: "btwFailed",
        sessionID: "ses_1",
        requestID: "req_1",
        error: "A side question is already running",
      },
    ])
  })

  it("reports a missing CLI backend for an ask", async () => {
    const { btw, posts } = subject(undefined)

    await btw.handle({ type: "btwAsk", sessionID: "ses_1", requestID: "req_1", question: "why?" })

    expect(posts).toEqual([
      { type: "btwFailed", sessionID: "ses_1", requestID: "req_1", error: "Not connected to CLI backend" },
    ])
  })

  it("reports a missing CLI backend for history", async () => {
    const { btw, posts } = subject(undefined)

    await btw.handle({ type: "btwHistory", sessionID: "ses_1" })

    expect(posts).toEqual([
      { type: "btwFailed", sessionID: "ses_1", requestID: undefined, error: "Not connected to CLI backend" },
    ])
  })

  it("loads the side question history for the session", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btwList: async (...args: unknown[]) => {
          calls.push(args)
          return { data: { items: [item] } }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwHistory", sessionID: "ses_1" })

    expect(posts).toEqual([{ type: "btwHistoryLoaded", sessionID: "ses_1", items: [item] }])
    expect(calls).toEqual([[{ sessionID: "ses_1", directory: "/repo" }, { throwOnError: true }]])
  })

  it("reports a history load failure without a request ID and with the fallback text", async () => {
    const { btw, posts } = subject({
      session: {
        btwList: async () => {
          throw new Error("")
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwHistory", sessionID: "ses_1" })

    expect(posts).toEqual([{ type: "btwFailed", sessionID: "ses_1", error: "Failed to load side questions" }])
    expect("requestID" in (posts[0] as Record<string, unknown>)).toBe(false)
  })

  it("ignores an empty question without calling the session API or posting", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btw: async (input: unknown) => {
          calls.push(input)
          return { data: item }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwAsk", sessionID: "ses_1", requestID: "req_1", question: "   " })

    expect(calls).toEqual([])
    expect(posts).toEqual([])
  })

  it("forwards the follow-up thread to the session API", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btw: async (input: unknown) => {
          calls.push(input)
          return { data: item }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({
      type: "btwAsk",
      sessionID: "ses_1",
      requestID: "req_2",
      question: "and then?",
      threadID: "btw_0",
    })

    expect(calls).toEqual([{ sessionID: "ses_1", directory: "/repo", question: "and then?", threadID: "btw_0" }])
    expect(posts).toEqual([{ type: "btwStarted", sessionID: "ses_1", requestID: "req_2", item }])
  })

  it("posts nothing when the CLI cancels the side question", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btwCancel: async (input: unknown, options: unknown) => {
          calls.push([input, options])
          return { data: { cancelled: true } }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwCancel", sessionID: "ses_1", btwID: "btw_1" })

    expect(calls).toEqual([[{ sessionID: "ses_1", btwID: "btw_1", directory: "/repo" }, { throwOnError: true }]])
    expect(posts).toEqual([])
  })

  it("ignores a cancel without a side question ID", async () => {
    const calls: unknown[] = []
    const { btw, posts } = subject({
      session: {
        btwCancel: async (input: unknown) => {
          calls.push(input)
          return { data: { cancelled: true } }
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwCancel", sessionID: "ses_1" })

    expect(calls).toEqual([])
    expect(posts).toEqual([])
  })

  it("refreshes the list when a cancel finds no live run", async () => {
    const { btw, posts } = subject({
      session: {
        btwCancel: async () => ({ data: { cancelled: false } }),
        btwList: async () => ({ data: { items: [] } }),
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwCancel", sessionID: "ses_1", btwID: "btw_missing" })

    expect(posts).toEqual([{ type: "btwHistoryLoaded", sessionID: "ses_1", items: [] }])
  })

  it("reports a cancel request that fails", async () => {
    const { btw, posts } = subject({
      session: {
        btwCancel: async () => {
          throw new Error("connection reset")
        },
      },
    } as unknown as KiloClient)

    await btw.handle({ type: "btwCancel", sessionID: "ses_1", btwID: "btw_1" })

    expect(posts).toEqual([{ type: "btwFailed", sessionID: "ses_1", error: "Could not cancel the side question." }])
  })

  it("scopes ask, cancel, and history to the directory of the message session", async () => {
    const dirs: string[] = []
    const asks: unknown[] = []
    const cancels: unknown[] = []
    const lists: unknown[] = []
    const btw = new KiloProviderBtw({
      client: () =>
        ({
          session: {
            btw: async (input: unknown) => {
              asks.push(input)
              return { data: item }
            },
            btwCancel: async (input: unknown) => {
              cancels.push(input)
              return { data: { cancelled: true } }
            },
            btwList: async (input: unknown) => {
              lists.push(input)
              return { data: { items: [item] } }
            },
          },
        }) as unknown as KiloClient,
      dir: (sessionID) => {
        dirs.push(sessionID)
        return `/repo/${sessionID}`
      },
      post: () => {},
    })

    await btw.handle({ type: "btwAsk", sessionID: "ses_a", requestID: "req_1", question: "why?" })
    await btw.handle({ type: "btwCancel", sessionID: "ses_b", btwID: "btw_1" })
    await btw.handle({ type: "btwHistory", sessionID: "ses_b" })

    expect(dirs).toEqual(["ses_a", "ses_b", "ses_b"])
    expect(asks).toEqual([{ sessionID: "ses_a", directory: "/repo/ses_a", question: "why?", threadID: undefined }])
    expect(cancels).toEqual([{ sessionID: "ses_b", btwID: "btw_1", directory: "/repo/ses_b" }])
    expect(lists).toEqual([{ sessionID: "ses_b", directory: "/repo/ses_b" }])
  })
})
