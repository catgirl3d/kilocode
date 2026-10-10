import { describe, expect, it } from "bun:test"

const { KiloProvider } = await import("../../src/KiloProvider")

type Internals = {
  handleUndoCompact(sessionID: string, messageID: string): Promise<void>
}

type Call =
  | {
      method: "messages"
      input: { sessionID: string; directory: string; limit: number }
      options: { throwOnError: true }
    }
  | {
      method: "deleteMessage"
      input: { sessionID: string; messageID: string; directory: string }
      options: { throwOnError: true }
    }

const marker = (id: string) => ({ info: { id, role: "user" }, parts: [{ type: "compaction" }] })
const summary = (id: string, parentID: string) => ({
  info: { id, role: "assistant", parentID, summary: true },
  parts: [],
})

function setup(messages: () => Promise<{ data: unknown }>, directory = "C:/workspace") {
  const calls: string[] = []
  const journal: Call[] = []
  const client = {
    session: {
      messages: async (
        input: { sessionID: string; directory: string; limit: number },
        options: { throwOnError: true },
      ) => {
        calls.push("messages")
        journal.push({ method: "messages", input, options })
        return messages()
      },
      deleteMessage: async (
        input: { sessionID: string; messageID: string; directory: string },
        options: { throwOnError: true },
      ) => {
        calls.push(`delete:${input.messageID}`)
        journal.push({ method: "deleteMessage", input, options })
        return { data: true }
      },
    },
  }
  const provider = new KiloProvider(
    {} as never,
    { getClient: () => client, resolveEventSessionId: () => undefined } as never,
  )
  Object.assign(provider, {
    getWorkspaceDirectory: () => directory,
    postMessage: () => {},
  })
  return { internal: provider as unknown as Internals, calls, journal }
}

describe("handleUndoCompact", () => {
  it("ignores a second undo while the first is still running", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { internal, calls } = setup(async () => {
      await gate
      return { data: [marker("c1"), summary("s1", "c1")] }
    })

    const first = internal.handleUndoCompact("s1", "c1")
    const second = internal.handleUndoCompact("s1", "c1")
    expect(calls.filter((call) => call === "messages")).toHaveLength(1)

    release()
    await Promise.all([first, second])

    expect(calls.filter((call) => call === "messages")).toHaveLength(1)
    expect(calls).toEqual(["messages", "delete:s1", "delete:c1"])
  })

  it("allows another undo after the first finishes", async () => {
    const { internal, calls } = setup(async () => ({ data: [marker("c1"), summary("s1", "c1")] }))

    await internal.handleUndoCompact("s1", "c1")
    await internal.handleUndoCompact("s1", "c1")

    expect(calls.filter((call) => call === "messages")).toHaveLength(2)
  })

  it("requests full history and routes deletion in the same workspace", async () => {
    const sessionID = "session-1"
    const markerID = "marker-1"
    const summaryID = "summary-1"
    const directory = "C:/expected-worktree"
    const { internal, journal } = setup(
      async () => ({ data: [marker(markerID), summary(summaryID, markerID)] }),
      directory,
    )

    await internal.handleUndoCompact(sessionID, markerID)

    expect(journal).toEqual([
      {
        method: "messages",
        input: { sessionID, directory, limit: 0 },
        options: { throwOnError: true },
      },
      {
        method: "deleteMessage",
        input: { sessionID, messageID: summaryID, directory },
        options: { throwOnError: true },
      },
      {
        method: "deleteMessage",
        input: { sessionID, messageID: markerID, directory },
        options: { throwOnError: true },
      },
    ])
  })
})
