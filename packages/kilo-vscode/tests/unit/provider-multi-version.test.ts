import { describe, expect, it, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Session } from "@kilocode/sdk/v2/client"
import { createMultiVersion, type MultiVersionHost } from "../../src/agent-manager/provider-multi-version"
import { WorktreeRollbackError } from "../../src/agent-manager/WorktreeManager"
import type { ProjectContext } from "../../src/agent-manager/project/context"
import type { CreateWorktreeOnDiskResult } from "../../src/agent-manager/worktree-create"

function fixture(input: {
  generated: string | null
  enabled?: boolean
  branchName?: string
  name?: string
  clientError?: boolean
}) {
  const events: string[] = []
  const row = { id: "wt-0", branch: "random-branch", path: "/repo/wt-0", branchOwned: true }
  const state = {
    addSession: mock((id: string) => events.push(`state:${id}`)),
    armAutoName: mock((id: string, session: string) => events.push(`arm:${id}:${session}`)),
    renameOwnedWorktree: mock((_id: string, _current: string, branch: string, path: string) => {
      row.branch = branch
      row.path = path
      events.push(`state-rename:${branch}:${path}`)
      return true
    }),
    removeWorktree: mock(() => events.push("state-remove")),
  }
  const manager = {
    renameWorktree: mock(async (_path: string, _current: string, branch: string) => {
      events.push(`rename:${branch}`)
      return { branch, path: `/repo/${branch}` }
    }),
    removeWorktree: mock(async () => events.push("remove")),
  }
  const client = {
    session: {
      create: mock(async () => {
        events.push("scratch-create")
        return { data: { id: "scratch-session" } }
      }),
      delete: mock(async () => {
        events.push("scratch-delete")
        return {}
      }),
    },
    branchName: {
      generate: mock(async () => {
        events.push("generate")
        return { data: { branch: input.generated } }
      }),
    },
  }
  const ctx = {
    id: "project-1",
    root: "/repo",
    stateManager: () => state,
    peekState: () => state,
    worktreeManager: () => manager,
  } as unknown as ProjectContext
  const host = {
    log: mock(() => {}),
    post: mock((message: { type?: string }) => {
      if (message.type === "agentManager.sendInitialMessage") events.push("prompt")
    }),
    createOnDisk: mock(async () => {
      events.push("disk")
      return {
        worktree: row,
        result: { path: row.path, branch: row.branch, parentBranch: "main" },
      } as CreateWorktreeOnDiskResult
    }),
    metadata: mock(async () => ({})),
    client: () => {
      if (input.clientError) throw new Error("client disconnected")
      return client as never
    },
    hasScript: () => false,
    runSetup: mock(async () => events.push("setup")),
    createSession: mock(async () => {
      events.push(`session:${row.path}`)
      return { id: "session-0" } as Session
    }),
    autoName: () => ({ enabled: input.enabled ?? true, prefix: "feat" }),
    register: mock(() => events.push(`register:${row.path}`)),
    notifyReady: mock(() => events.push(`ready:${row.path}`)),
    sessions: { register: mock(() => {}) },
    promptName: mock(() => {}),
    capture: mock(() => {}),
    error: mock(() => {}),
    discard: mock(async () => {}),
  } as unknown as MultiVersionHost

  return { client, ctx, events, host, manager, row, state }
}

describe("multi-version provisioning", () => {
  it("renames before setup and session creation", async () => {
    const { client, ctx, events, host, row, state } = fixture({ generated: "Fix Token Refresh" })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Token Refresh",
      versions: 1,
    })

    expect(client.branchName.generate).toHaveBeenCalledTimes(1)
    expect(events.indexOf("rename:feat/fix-token-refresh")).toBeLessThan(events.indexOf("setup"))
    expect(events.indexOf("rename:feat/fix-token-refresh")).toBeLessThan(
      events.indexOf("session:/repo/feat/fix-token-refresh"),
    )
    expect(row).toMatchObject({ branch: "feat/fix-token-refresh", path: "/repo/feat/fix-token-refresh" })
    expect(state.renameOwnedWorktree).toHaveBeenCalledWith(
      "wt-0",
      "random-branch",
      "feat/fix-token-refresh",
      "/repo/feat/fix-token-refresh",
    )
  })

  it("creates the session at the random path when generation returns null", async () => {
    const { client, ctx, events, host, manager, row, state } = fixture({ generated: null })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Vague request",
      versions: 1,
    })

    expect(client.branchName.generate).toHaveBeenCalledTimes(1)
    expect(manager.renameWorktree).not.toHaveBeenCalled()
    expect(events).toContain("session:/repo/wt-0")
    expect(row).toMatchObject({ branch: "random-branch", path: "/repo/wt-0" })
    expect(state.armAutoName).toHaveBeenCalledWith("wt-0", "session-0")
  })

  it("keeps provisioning at the random path when the client getter throws", async () => {
    const { ctx, events, host, manager } = fixture({ generated: "Unused", clientError: true })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix it",
      versions: 1,
    })

    expect(manager.renameWorktree).not.toHaveBeenCalled()
    expect(events).toContain("session:/repo/wt-0")
    expect(host.log).toHaveBeenCalledWith(expect.stringContaining("client disconnected"))
  })

  it("does not arm multi-version fallback worktrees", async () => {
    const { ctx, host, state } = fixture({ generated: null })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix it",
      versions: 2,
    })

    expect(state.armAutoName).not.toHaveBeenCalled()
  })

  it.each([
    { label: "explicit branch", branchName: "feature/existing" },
    { label: "explicit worktree name", name: "Prepared" },
  ])("does not generate an explicit $label", async ({ branchName, name }) => {
    const { client, ctx, events, host, manager } = fixture({ generated: "Unused", branchName, name })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix it",
      versions: 1,
      branchName,
      name,
    })

    expect(client.branchName.generate).not.toHaveBeenCalled()
    expect(manager.renameWorktree).not.toHaveBeenCalled()
    expect(events).toContain("session:/repo/wt-0")
  })

  it("finishes git creation before provisioning at bounded concurrency", async () => {
    const flow: string[] = []
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const state = { addSession: mock(() => {}), armAutoName: mock(() => {}) }
    const ctx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => ({ removeWorktree: mock(async () => {}) }),
    } as unknown as ProjectContext
    const host = {
      log: mock(() => {}),
      post: mock((message: { type: string; sessionId?: string }) => {
        if (message.type === "agentManager.sendInitialMessage") flow.push(`prompt:${message.sessionId}`)
      }),
      createOnDisk: mock(async (opts: { branchName?: string }) => {
        const index = opts.branchName?.endsWith("_v2") ? 1 : opts.branchName?.endsWith("_v3") ? 2 : 0
        flow.push(`git:${index}`)
        return {
          worktree: { id: `wt-${index}` },
          result: { path: `/repo/wt-${index}`, branch: `branch-${index}`, parentBranch: "main" },
        } as CreateWorktreeOnDiskResult
      }),
      runSetup: mock(async (dir: string) => {
        const index = Number(dir.at(-1)!)
        flow.push(`setup:${index}`)
        if (index < 2) {
          entered[index]?.resolve()
          await gates[index]?.promise
        }
      }),
      hasScript: () => true,
      createSession: mock(async (dir: string) => ({ id: `session-${dir.at(-1)!}` }) as Session),
      autoName: () => ({ enabled: false, prefix: "" }),
      register: mock(() => {}),
      notifyReady: mock(() => {}),
      sessions: { register: mock(() => {}) },
      promptName: mock(() => {}),
      capture: mock(() => {}),
      error: mock(() => {}),
    } as unknown as MultiVersionHost

    const pending = createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix it",
      branchName: "fix-it",
      versions: 3,
    })
    await Promise.all(entered.map((entry) => entry.promise))

    expect(flow.slice(0, 5)).toEqual(["git:0", "git:1", "git:2", "setup:0", "setup:1"])
    expect(flow).not.toContain("setup:2")

    gates.forEach((gate) => gate.resolve())
    await pending

    expect(flow).toContain("setup:2")
    expect(flow.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
  })

  it("uses the detailed no-commit error in the final notification", async () => {
    const message = "This repository has no commits yet. Create an initial commit before using worktrees."
    const error = mock(() => {})
    const host = {
      createOnDisk: mock(async (opts: { onError?: (failure: { message: string; code?: string }) => void }) => {
        opts.onError?.({ message, code: "no_commits" })
        return null
      }),
      log: () => {},
      post: () => {},
      error,
    } as unknown as MultiVersionHost

    await createMultiVersion({ id: "project-1" } as ProjectContext, host, {
      type: "agentManager.createMultiVersion",
      versions: 1,
    })

    expect(error).toHaveBeenCalledWith(message)
  })

  it("keeps the generic notification for other failures", async () => {
    const error = mock(() => {})
    const host = {
      createOnDisk: mock(async (opts: { onError?: (failure: { message: string }) => void }) => {
        opts.onError?.({ message: "Branch already exists" })
        return null
      }),
      log: () => {},
      post: () => {},
      error,
    } as unknown as MultiVersionHost

    await createMultiVersion({ id: "project-1" } as ProjectContext, host, {
      type: "agentManager.createMultiVersion",
      versions: 1,
    })

    expect(error).toHaveBeenCalledWith("Failed to create any of the 1 multi-version worktrees.")
  })

  it("generates one shared name with distinct model payloads and per-session paths", async () => {
    const rows = [
      { id: "wt-0", branch: "random-0", path: "/repo/wt-0", branchOwned: true },
      { id: "wt-1", branch: "random-1", path: "/repo/wt-1", branchOwned: true },
    ]
    const state = {
      addSession: mock(() => {}),
      armAutoName: mock(() => {}),
      renameOwnedWorktree: mock(() => true),
    }
    const generated = mock(async () => ({ data: { branch: "Fix Shared Name" } }))
    const names: string[] = []
    const prompts: unknown[] = []
    let index = 0
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "scratch-session" } })),
        delete: mock(async () => ({})),
      },
      branchName: { generate: generated },
    }
    const manager = {
      renameWorktree: mock(async (source: string, _current: string, branch: string) => {
        names.push(branch)
        return { branch, path: `/repo/named-${source.endsWith("wt-1") ? 1 : 0}` }
      }),
      removeWorktree: mock(async () => {}),
    }
    const stateCtx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => manager,
    } as unknown as ProjectContext
    const host = {
      log: () => {},
      post: (message: Record<string, unknown>) => {
        if (message.type === "agentManager.sendInitialMessage") prompts.push(message)
      },
      createOnDisk: mock(async () => {
        const row = rows[index++]!
        return {
          worktree: row,
          result: { path: row.path, branch: row.branch, parentBranch: "main" },
        } as CreateWorktreeOnDiskResult
      }),
      metadata: async () => ({}),
      client: () => client as never,
      hasScript: () => false,
      runSetup: async () => {},
      createSession: async (_dir: string, _branch: string, id: string) =>
        ({ id: `session-${id.slice(-1)}` }) as Session,
      autoName: () => ({ enabled: true, prefix: "feat" }),
      register: mock(() => {}),
      notifyReady: mock(() => {}),
      sessions: { register: mock(() => {}) },
      promptName: mock(() => {}),
      capture: mock(() => {}),
      error: mock(() => {}),
      discard: mock(async () => {}),
    } as unknown as MultiVersionHost

    await createMultiVersion(stateCtx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Shared Name",
      versions: 2,
      modelAllocations: [
        { providerID: "provider-a", modelID: "model-a", count: 1 },
        { providerID: "provider-b", modelID: "model-b", count: 1 },
      ],
    })

    const scratch = path.join(os.tmpdir(), "kilo-worktree-naming-")
    expect(generated).toHaveBeenCalledTimes(1)
    expect(generated).toHaveBeenCalledWith(
      {
        directory: expect.stringContaining(scratch),
        sessionID: "scratch-session",
        prompt: "Fix Shared Name",
        providerID: "provider-a",
        modelID: "model-a",
      },
      expect.objectContaining({ throwOnError: true }),
    )
    expect(generated.mock.calls[0]?.[1]).toHaveProperty("signal")
    expect(names).toEqual(["feat/fix-shared-name", "feat/fix-shared-name_v2"])
    expect(prompts).toEqual([
      expect.objectContaining({ providerID: "provider-a", modelID: "model-a" }),
      expect.objectContaining({ providerID: "provider-b", modelID: "model-b" }),
    ])
  })

  it("fails one naming rollback without blocking a healthy sibling", async () => {
    const rows = [
      { id: "wt-0", branch: "random-0", path: "/repo/wt-0", branchOwned: true },
      { id: "wt-1", branch: "random-1", path: "/repo/wt-1", branchOwned: true },
    ]
    const state = {
      addSession: mock(() => {}),
      armAutoName: mock(() => {}),
      renameOwnedWorktree: mock(() => true),
      removeWorktree: mock(() => {}),
    }
    let index = 0
    const prompts: string[] = []
    const removed: string[] = []
    const client = {
      session: {
        create: mock(async () => ({ data: { id: "scratch-session" } })),
        delete: mock(async () => ({})),
      },
      branchName: { generate: mock(async () => ({ data: { branch: "Fix Shared Name" } })) },
      kilocode: { removeSnapshot: mock(async () => ({})) },
    }
    const manager = {
      renameWorktree: mock(async (source: string, _current: string, branch: string) => {
        if (source.endsWith("wt-0")) throw new WorktreeRollbackError("rollback refused")
        return { branch, path: "/repo/fix-shared-name-v2" }
      }),
      removeWorktree: mock(async (_path: string, branch: string) => removed.push(branch)),
    }
    const stateCtx = {
      id: "project-1",
      root: "/repo",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => manager,
    } as unknown as ProjectContext
    const messages: Record<string, unknown>[] = []
    const create = mock(
      async (_dir: string, _branch: string, id: string) => ({ id: `session-${id.slice(-1)}` }) as Session,
    )
    const host = {
      log: mock(() => {}),
      post: (message: Record<string, unknown>) => {
        messages.push(message)
        if (message.type === "agentManager.sendInitialMessage") prompts.push(String(message.sessionId))
      },
      createOnDisk: mock(async () => {
        const row = rows[index++]!
        return {
          worktree: row,
          result: { path: row.path, branch: row.branch, parentBranch: "main" },
        } as CreateWorktreeOnDiskResult
      }),
      metadata: async () => ({}),
      client: () => client as never,
      hasScript: () => false,
      runSetup: async () => {},
      createSession: create,
      autoName: () => ({ enabled: true, prefix: "feat" }),
      register: mock(() => {}),
      notifyReady: mock(() => {}),
      sessions: { register: mock(() => {}) },
      promptName: mock(() => {}),
      capture: mock(() => {}),
      error: mock(() => {}),
      discard: mock(async () => {}),
    } as unknown as MultiVersionHost

    await createMultiVersion(stateCtx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Shared Name",
      versions: 2,
    })

    expect(prompts).toEqual(["session-1"])
    expect(removed).toEqual(["random-0"])
    expect(create).toHaveBeenCalledTimes(1)
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({ type: "agentManager.multiVersionProgress", status: "done", completed: 1 }),
    )
  })

  it("cleans a renamed residual target and removes its state row", async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-target-"))
    try {
      const { ctx, host, manager, state } = fixture({ generated: "Fix it" })
      manager.renameWorktree.mockRejectedValue(
        new WorktreeRollbackError("rollback refused", {
          source: "/repo/wt-0",
          target,
          branch: "feat/fix-it",
        }),
      )

      await createMultiVersion(ctx, host, {
        type: "agentManager.createMultiVersion",
        text: "Fix it",
        versions: 1,
      })

      expect(manager.removeWorktree).toHaveBeenCalledWith(target, "feat/fix-it")
      expect(state.removeWorktree).toHaveBeenCalledWith("wt-0")
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it("removes state when neither rollback path exists", async () => {
    const { ctx, host, manager, state } = fixture({ generated: "Fix it" })
    manager.renameWorktree.mockRejectedValue(
      new WorktreeRollbackError("rollback refused", {
        source: "/repo/wt-0",
        target: "/missing-target",
        branch: "feat/fix-it",
      }),
    )

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix it",
      versions: 1,
    })

    expect(manager.removeWorktree).toHaveBeenCalledWith("/repo/wt-0", "random-branch")
    expect(state.removeWorktree).toHaveBeenCalledWith("wt-0")
  })
})
