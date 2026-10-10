import { describe, expect, it } from "bun:test"

const { KiloProvider } = await import("../../src/KiloProvider")

type Internals = {
  handleUndoCompact(sessionID: string, messageID: string): Promise<void>
}

const marker = (id: string) => ({ info: { id, role: "user" }, parts: [{ type: "compaction" }] })
const summary = (id: string, parentID: string) => ({
  info: { id, role: "assistant", parentID, summary: true },
  parts: [],
})

function setup(messages: () => Promise<{ data: unknown }>) {
  const calls: string[] = []
  const client = {
    session: {
      messages: async () => {
        calls.push("messages")
        return messages()
      },
      deleteMessage: async (input: { messageID: string }) => {
        calls.push(`delete:${input.messageID}`)
        return { data: true }
      },
    },
  }
  const provider = new KiloProvider(
    {} as never,
    { getClient: () => client, resolveEventSessionId: () => undefined } as never,
  )
  Object.assign(provider, {
    getWorkspaceDirectory: () => "C:/workspace",
    postMessage: () => {},
  })
  return { internal: provider as unknown as Internals, calls }
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
})
