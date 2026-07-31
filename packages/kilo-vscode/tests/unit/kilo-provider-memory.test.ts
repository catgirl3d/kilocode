import { describe, expect, it, spyOn } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import * as vscode from "vscode"
import { KiloProviderMemory } from "../../src/kilo-provider/memory"

function subject(client: KiloClient | undefined) {
  const posts: unknown[] = []
  const memory = new KiloProviderMemory({
    client: () => client,
    session: () => undefined,
    dir: () => "/repo",
    post: (message) => posts.push(message),
  })
  return { memory, posts }
}

function status(root: string) {
  return {
    root: `${root}/.kilo/memory`,
    state: {
      enabled: true,
      scope: "project",
      autoConsolidate: true,
      stats: {
        lastInjectedSessionID: "",
        lastInjectedTokens: 0,
        lastOperationCount: 0,
      },
    },
    index: { estimatedTokens: 0 },
  }
}

function show(root: string) {
  return {
    root: `${root}/.kilo/memory`,
    state: status(root).state,
    sources: { project: "", environment: "", corrections: "" },
    index: "",
    items: "",
    changes: "",
    decisions: "",
  }
}

describe("KiloProviderMemory", () => {
  it("opens the complete project memory document", async () => {
    const open = spyOn(vscode.workspace, "openTextDocument")
    const present = spyOn(vscode.window, "showTextDocument")
    const full = status("/repo")
    const view = show("/repo")
    view.items = "record id=project.md:Facts:test :: Stored memory fact :: with context"
    const item = subject({
      memory: {
        show: async () => ({ data: view }),
        status: async () => ({ data: full }),
      },
    } as unknown as KiloClient)

    try {
      await item.memory.show("ses_stored")

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          language: "markdown",
          content: expect.stringContaining("Stored memory fact :: with context"),
        }),
      )
      expect(present).toHaveBeenCalledWith(expect.anything(), { preview: true })
    } finally {
      open.mockRestore()
      present.mockRestore()
    }
  })

  it("keeps slash memory status and show in the Quick Pick", async () => {
    const picker = spyOn(vscode.window, "showQuickPick")
    const view = show("/repo")
    view.items = "record id=project.md:Facts:test :: Stored memory fact"
    const item = subject({
      memory: {
        show: async () => ({ data: view }),
        status: async () => ({ data: status("/repo") }),
      },
    } as unknown as KiloClient)

    try {
      await item.memory.handle({ type: "memoryShow", mode: "status", sessionID: "ses_memory" })
      await item.memory.handle({ type: "memoryShow", mode: "show", sessionID: "ses_memory" })

      expect(picker).toHaveBeenCalledTimes(2)
      expect(picker.mock.calls[0]?.[1]).toMatchObject({ title: "Memory status" })
      expect(picker.mock.calls[1]?.[0]).toContainEqual(expect.objectContaining({ label: "Stored memory fact" }))
    } finally {
      picker.mockRestore()
    }
  })

  it("routes inspect operations to the memory folder", async () => {
    const reveal = spyOn(vscode.commands, "executeCommand")
    const item = subject({
      memory: {
        status: async () => ({ data: status("/repo") }),
        show: async () => ({ data: show("/repo") }),
      },
    } as unknown as KiloClient)

    try {
      await item.memory.run({ operation: "inspect", sessionID: "ses_inspect" })

      expect(reveal).toHaveBeenCalledWith("revealFileInOS", expect.objectContaining({ fsPath: "/repo/.kilo/memory" }))
      expect(item.posts).toContainEqual(
        expect.objectContaining({ type: "memoryOperationResult", operation: "inspect", ok: true }),
      )
    } finally {
      reveal.mockRestore()
    }
  })

  it("handles clients without memory endpoints gracefully", async () => {
    const item = subject({} as KiloClient)

    await item.memory.fetch("ses_memoryless")
    await item.memory.show("ses_memoryless")
    await item.memory.run({ operation: "enable", sessionID: "ses_memoryless" })

    expect(item.posts).toEqual([
      {
        type: "memoryLoaded",
        sessionID: "ses_memoryless",
        error: "Memory unavailable in CLI backend",
      },
      {
        type: "memoryLoaded",
        sessionID: "ses_memoryless",
        error: "Memory unavailable in CLI backend",
      },
      {
        type: "memoryOperationResult",
        operation: "enable",
        sessionID: "ses_memoryless",
        ok: false,
        error: "Memory unavailable in CLI backend",
      },
    ])
  })

  it("posts a load error when no client or cache exists", async () => {
    const item = subject(undefined)

    await item.memory.fetch("ses_disconnected")

    expect(item.posts).toEqual([
      {
        type: "memoryLoaded",
        sessionID: "ses_disconnected",
        error: "Not connected to CLI backend",
      },
    ])
  })

  it("evicts older cached memory payloads", async () => {
    let client: KiloClient | undefined
    const posts: unknown[] = []
    const item = new KiloProviderMemory({
      client: () => client,
      session: () => undefined,
      dir: (sid) => `/repo/${sid ?? "current"}`,
      post: (message) => posts.push(message),
    })
    client = {
      memory: {
        status: async (input: { directory: string }) => ({ data: status(input.directory) }),
        show: async (input: { directory: string }) => ({ data: show(input.directory) }),
      },
    } as unknown as KiloClient

    for (let i = 0; i < 9; i++) {
      await item.show(`ses_${i}`)
    }

    posts.length = 0
    client = undefined
    await item.fetch("ses_0")
    await item.fetch("ses_8")

    expect(posts[0]).toEqual({
      type: "memoryLoaded",
      sessionID: "ses_0",
      error: "Not connected to CLI backend",
    })
    expect(posts[1]).toMatchObject({
      type: "memoryLoaded",
      sessionID: "ses_8",
      status: { root: "/repo/ses_8/.kilo/memory" },
    })
  })

  it("does not send ignored placement fields to correction endpoint", async () => {
    const calls: unknown[] = []
    const state = status("/repo")
    const view = show("/repo")
    const item = subject({
      memory: {
        correct: async (input: unknown) => {
          calls.push(input)
          return { data: { operationCount: 1, added: 1, removed: 0, skipped: [], index: { tokens: 0 } } }
        },
        status: async () => ({ data: state }),
        show: async () => ({ data: view }),
      },
    } as unknown as KiloClient)

    await item.memory.run({
      operation: "correct",
      sessionID: "ses_correct",
      text: "Prefer corrections.",
      key: "correction_key",
      file: "project.md",
      section: "Facts",
    })

    expect(calls).toEqual([
      {
        directory: "/repo",
        text: "Prefer corrections.",
        key: "correction_key",
        sessionID: "ses_correct",
      },
    ])
  })

  it("routes status operations without mutating memory", async () => {
    const calls: string[] = []
    const state = status("/repo")
    const item = subject({
      memory: {
        status: async () => {
          calls.push("status")
          return { data: state }
        },
      },
    } as unknown as KiloClient)

    await item.memory.run({ operation: "status", sessionID: "ses_memory" })

    expect(calls).toEqual(["status"])
    expect(item.posts).toContainEqual(
      expect.objectContaining({ type: "memoryOperationResult", operation: "status", ok: true, result: state }),
    )
    expect(item.posts).toContainEqual(expect.objectContaining({ type: "memoryLoaded", status: state }))
  })

  it("routes auto-save and purge operations with explicit payloads", async () => {
    const calls: unknown[] = []
    const state = status("/repo")
    const view = show("/repo")
    state.state.autoConsolidate = false
    const item = subject({
      memory: {
        configure: async (input: unknown) => {
          calls.push(["configure", input])
          return { data: { root: "/repo/.kilo/memory", state: state.state } }
        },
        purge: async (input: unknown) => {
          calls.push(["purge", input])
          return { data: { root: "/repo/.kilo/memory", purged: true } }
        },
        status: async () => ({ data: state }),
        show: async () => ({ data: view }),
      },
    } as unknown as KiloClient)

    await item.memory.run({ operation: "auto", mode: "off", sessionID: "ses_memory" })
    await item.memory.run({ operation: "purge", confirm: true, sessionID: "ses_memory" })

    expect(calls).toEqual([
      ["configure", { directory: "/repo", autoConsolidate: false }],
      ["purge", { directory: "/repo", confirm: true }],
    ])
    expect(item.posts.filter((post) => (post as { type?: string }).type === "memoryOperationResult")).toHaveLength(2)
  })

  it("restores verbose and prompted memory actions", async () => {
    const calls: unknown[] = []
    const input = spyOn(vscode.window, "showInputBox").mockResolvedValue("Remember this project convention")
    const state = status("/repo")
    const item = subject({
      memory: {
        configure: async (value: unknown) => {
          calls.push(["configure", value])
          return { data: { root: state.root, state: state.state } }
        },
        remember: async (value: unknown) => {
          calls.push(["remember", value])
          return { data: { operationCount: 1, added: 1, removed: 0, skipped: [], index: { tokens: 0 } } }
        },
        status: async () => ({ data: state }),
      },
    } as unknown as KiloClient)

    try {
      await item.memory.handle({ type: "memoryPrompt", operation: "remember", sessionID: "ses_memory" })
      await item.memory.run({ operation: "verbose", mode: "on", sessionID: "ses_memory" })

      expect(calls).toEqual([
        ["remember", { directory: "/repo", text: "Remember this project convention", sessionID: "ses_memory" }],
        ["configure", { directory: "/repo", verbose: true }],
      ])
      expect(item.posts).toContainEqual(
        expect.objectContaining({ type: "memoryOperationResult", operation: "verbose", ok: true }),
      )
    } finally {
      input.mockRestore()
    }
  })
})
