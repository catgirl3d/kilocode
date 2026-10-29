import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { forkText } from "../../src/agent-manager/fork-handoff"
import { forkSession, type ForkContext } from "../../src/agent-manager/fork-session"

const noop = () => {}
const refusal = "Wait for the session to finish before forking it."

function session(id: string): Session {
  return { id, title: id, createdAt: "", updatedAt: "" } as Session
}

function reply(type: string) {
  return mock(async () => ({ data: { source: { type } } }))
}

function ctx(client: unknown, overrides: Partial<ForkContext> = {}): ForkContext {
  return {
    getClient: () => client as never,
    state: undefined,
    directory: "/repo",
    postError: noop,
    registerWorktreeSession: noop,
    pushState: noop,
    notifyForked: noop,
    registerSession: noop,
    log: noop,
    ...overrides,
  }
}

describe("agent manager fork session", () => {
  it("records the hidden handoff in the current repository", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const promptAsync = mock(async () => ({}))
    const client = { session: { fork, promptAsync, status: reply("idle") } }

    await forkSession(ctx(client), "source", undefined, "message")

    expect(fork).toHaveBeenCalledWith(
      { sessionID: "source", directory: "/repo", messageID: "message" },
      { throwOnError: true },
    )
    expect(promptAsync).toHaveBeenCalledWith(
      {
        sessionID: "forked",
        directory: "/repo",
        noReply: true,
        parts: [{ type: "text", text: forkText({ directory: "/repo" }), synthetic: true }],
      },
      { throwOnError: true },
    )
  })

  it("uses the selected worktree directory for the handoff", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const promptAsync = mock(async () => ({}))
    const client = { session: { fork, promptAsync, status: reply("idle") } }
    const state = {
      getWorktree: () => ({ path: "/repo/.kilo/worktrees/feature" }),
      addSession: mock(() => undefined),
    }

    await forkSession(ctx(client, { state: state as never }), "source", "worktree")

    expect(fork).toHaveBeenCalledWith(
      { sessionID: "source", directory: "/repo/.kilo/worktrees/feature" },
      { throwOnError: true },
    )
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ directory: "/repo/.kilo/worktrees/feature" }), {
      throwOnError: true,
    })
  })

  it("still exposes the fork when recording the handoff fails", async () => {
    const notify = mock(() => undefined)
    const log = mock(() => undefined)
    const client = {
      session: {
        fork: mock(async () => ({ data: session("forked") })),
        promptAsync: mock(async () => {
          throw new Error("handoff failed")
        }),
        status: reply("idle"),
      },
    }

    await forkSession(ctx(client, { notifyForked: notify, log }), "source")

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: "forked" }), "source", undefined)
    expect(log).toHaveBeenCalledWith("forkSession: failed to record fork handoff:", "handoff failed")
  })

  it("forks an idle source and checks its status in the repository", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const status = reply("idle")
    const client = { session: { fork, promptAsync: mock(async () => ({})), status } }

    await forkSession(ctx(client), "source")

    expect(status).toHaveBeenCalledWith({ directory: "/repo" }, { throwOnError: true })
    expect(fork).toHaveBeenCalledTimes(1)
  })

  it("refuses a running source before forking", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const postError = mock(() => undefined)
    const client = { session: { fork, promptAsync: mock(async () => ({})), status: reply("busy") } }

    const result = await forkSession(ctx(client, { postError }), "source")

    expect(result).toBeNull()
    expect(fork).not.toHaveBeenCalled()
    expect(postError).toHaveBeenCalledWith(refusal)
  })

  it("refuses when the status request fails", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const postError = mock(() => undefined)
    const log = mock(() => undefined)
    const client = {
      session: {
        fork,
        promptAsync: mock(async () => ({})),
        status: mock(async () => {
          throw new Error("backend down")
        }),
      },
    }

    await forkSession(ctx(client, { postError, log }), "source")

    expect(fork).not.toHaveBeenCalled()
    expect(postError).toHaveBeenCalledWith(refusal)
    expect(log).toHaveBeenCalledWith("forkSession: status check failed:", "backend down")
  })

  it("checks a worktree source against the worktree directory", async () => {
    const fork = mock(async () => ({ data: session("forked") }))
    const status = reply("busy")
    const postError = mock(() => undefined)
    const client = { session: { fork, promptAsync: mock(async () => ({})), status } }
    const state = {
      getWorktree: () => ({ path: "/repo/.kilo/worktrees/feature" }),
      addSession: mock(() => undefined),
    }

    await forkSession(ctx(client, { state: state as never, postError }), "source", "worktree")

    expect(status).toHaveBeenCalledWith({ directory: "/repo/.kilo/worktrees/feature" }, { throwOnError: true })
    expect(fork).not.toHaveBeenCalled()
    expect(postError).toHaveBeenCalledWith(refusal)
  })
})
