import { describe, expect, it, mock } from "bun:test"
import type { Session } from "@kilocode/sdk/v2/client"
import { createMultiVersion, type MultiVersionHost } from "../../src/agent-manager/provider-multi-version"
import type { ProjectContext } from "../../src/agent-manager/project/context"
import type { CreateWorktreeOnDiskResult } from "../../src/agent-manager/worktree-create"

function naming(input: { enabled: boolean; owned: boolean }) {
  const row = {
    id: "wt-0",
    branch: "random-branch",
    path: "/repo/wt-0",
    branchOwned: input.owned,
  }
  const calls: string[] = []
  const state = {
    addSession: mock(() => {}),
    armAutoName: mock(() => {}),
    renameOwnedWorktree: mock((_id: string, _current: string, branch: string, path: string) => {
      row.branch = branch
      row.path = path
      return true
    }),
  }
  const manager = {
    renameWorktree: mock(async (_path: string, _current: string, requested: string) => ({
      branch: requested,
      path: "/repo/wt-fix-token-refresh",
    })),
  }
  const moves: unknown[] = []
  const client = {
    branchName: {
      generate: mock(async (payload: unknown) => {
        calls.push(`generate:${JSON.stringify(payload)}`)
        return { data: { branch: "Fix Token Refresh" } }
      }),
    },
    experimental: {
      controlPlane: {
        moveSession: mock(async (payload: unknown) => moves.push(payload)),
      },
    },
  }
  const ctx = {
    id: "project-1",
    stateManager: () => state,
    peekState: () => state,
    worktreeManager: () => ({ ...manager, removeWorktree: mock(async () => {}) }),
  } as unknown as ProjectContext
  const host = {
    log: mock(() => {}),
    post: mock((msg: { type?: string }) => {
      if (msg.type === "agentManager.sendInitialMessage") calls.push("prompt")
    }),
    createOnDisk: mock(
      async () =>
        ({
          worktree: row,
          result: { path: row.path, branch: row.branch, parentBranch: "main" },
        }) as CreateWorktreeOnDiskResult,
    ),
    metadata: mock(async () => ({})),
    client: () => client,
    hasScript: () => false,
    runSetup: mock(async () => undefined),
    createSession: mock(async () => ({ id: "session-0" }) as Session),
    autoName: () => ({ enabled: input.enabled, prefix: "feat" }),
    register: mock((_id: string, path: string) => calls.push(`register:${path}`)),
    notifyReady: mock((_id: string, result: { path: string; branch: string }) =>
      calls.push(`ready:${result.path}:${result.branch}`),
    ),
    sessions: { register: mock(() => {}) },
    promptName: mock(() => calls.push(`prompt-state:${row.path}:${row.branch}`)),
    capture: mock(() => {}),
    error: mock(() => {}),
    discard: mock(async () => {}),
  } as unknown as MultiVersionHost

  return { calls, client, ctx, host, manager, moves, row, state }
}

describe("multi-version provisioning", () => {
  it.each([
    { name: "Fix login", branches: ["fix-login", "fix-login-v2"] },
    { name: "!!!", branches: [undefined, "v2"] },
    { name: "a".repeat(60), branches: ["a".repeat(50), "a".repeat(50)] },
    { name: undefined, branches: [undefined, undefined] },
    { name: "Fix login", branchName: "Feature/My_fix.v2", branches: ["Feature/My_fix.v2", "Feature/My_fix.v2_v2"] },
    { name: "Fix login", branchName: " invalid ", branches: [" invalid ", " invalid _v2"] },
  ])("keeps automatic display-name slugging separate from explicit refs: %j", async (input) => {
    const create = mock(async (_opts: { branchName?: string }) => null)
    const host = {
      createOnDisk: create,
      log: () => {},
      post: () => {},
      error: () => {},
    } as unknown as MultiVersionHost
    await createMultiVersion({ id: "project-1" } as ProjectContext, host, {
      type: "agentManager.createMultiVersion",
      versions: 2,
      name: input.name,
      branchName: "branchName" in input ? input.branchName : undefined,
    })
    expect(create.mock.calls.map(([opts]) => opts.branchName)).toEqual(input.branches)
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
      post: mock((msg: { type: string; sessionId?: string }) => {
        if (msg.type === "agentManager.sendInitialMessage") flow.push(`prompt:${msg.sessionId}`)
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

  it.each([false, true])("gates initial prompts on setup script presence (%s)", async (script) => {
    const flow: string[] = []
    const setupEntered = Promise.withResolvers<void>()
    const setupGate = Promise.withResolvers<void>()
    const prompted = Promise.withResolvers<void>()
    const state = { addSession: mock(() => {}), armAutoName: mock(() => {}) }
    const ctx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => ({ removeWorktree: mock(async () => {}) }),
    } as unknown as ProjectContext
    const host = {
      log: mock(() => {}),
      post: mock((msg: { type: string }) => {
        if (msg.type !== "agentManager.sendInitialMessage") return
        flow.push("prompt")
        prompted.resolve()
      }),
      createOnDisk: mock(async () => {
        return {
          worktree: { id: "wt-0" },
          result: { path: "/repo/wt-0", branch: "branch-0", parentBranch: "main" },
        } as CreateWorktreeOnDiskResult
      }),
      metadata: mock(async () => {
        flow.push("boot")
        return {}
      }),
      client: () => ({}) as never,
      hasScript: () => script,
      runSetup: mock(async (_dir: string, _branch: string, _id: string, early?: () => Promise<void>) => {
        flow.push("setup:start")
        flow.push("env")
        await early?.()
        setupEntered.resolve()
        await setupGate.promise
        flow.push("setup:end")
      }),
      createSession: mock(
        async (_dir: string, _branch: string, _id: string, boot: { metadata: () => Promise<unknown> }) => {
          flow.push("create")
          await boot.metadata()
          return { id: "session-0" } as Session
        },
      ),
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
      versions: 1,
    })
    await setupEntered.promise

    if (!script) await prompted.promise
    expect(flow.includes("prompt")).toBe(!script)
    expect(flow.includes("boot")).toBe(!script)

    setupGate.resolve()
    await pending

    expect(flow).toEqual(
      script
        ? ["setup:start", "env", "setup:end", "boot", "create", "prompt"]
        : ["setup:start", "env", "boot", "create", "prompt", "setup:end"],
    )
  })

  it("renames an unlabelled prompted version before notifying or prompting", async () => {
    const { calls, ctx, host, moves, row, state } = naming({ enabled: true, owned: true })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Token Refresh",
      versions: 1,
    })

    expect(calls).toContain("register:/repo/wt-fix-token-refresh")
    expect(calls).toContain("ready:/repo/wt-fix-token-refresh:feat/fix-token-refresh")
    expect(calls).toContain("prompt-state:/repo/wt-fix-token-refresh:feat/fix-token-refresh")
    expect(calls.at(-1)).toBe("prompt")
    expect(moves).toEqual([
      {
        sessionID: "session-0",
        destination: { directory: "/repo/wt-fix-token-refresh" },
        moveChanges: false,
      },
    ])
    expect(state.renameOwnedWorktree).toHaveBeenCalledWith(
      "wt-0",
      "random-branch",
      "feat/fix-token-refresh",
      "/repo/wt-fix-token-refresh",
    )
    expect(state.armAutoName).not.toHaveBeenCalled()
    expect(calls[0]).toContain('generate:{"directory":"/repo/wt-0"')
  })

  it.each([
    { label: "automatic naming disabled", enabled: false, owned: true },
    { label: "worktree is unowned", enabled: true, owned: false },
  ])("does not call naming for $label when all other guards are eligible", async ({ enabled, owned }) => {
    const { client, ctx, host, manager, moves, row } = naming({ enabled, owned })

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Token Refresh",
      versions: 1,
    })

    expect(client.branchName.generate).not.toHaveBeenCalled()
    expect(manager.renameWorktree).not.toHaveBeenCalled()
    expect(moves).toEqual([])
    expect(row).toMatchObject({ branch: "random-branch", path: "/repo/wt-0", branchOwned: owned })
    expect(host.register).toHaveBeenCalledWith("session-0", "/repo/wt-0")
    expect(host.notifyReady).toHaveBeenCalled()
    expect(host.promptName).toHaveBeenCalledWith({
      sessionID: "session-0",
      text: "Fix Token Refresh",
      providerID: undefined,
      modelID: undefined,
    })
  })

  it("arms the existing automatic naming flow when generation returns null", async () => {
    const row = {
      id: "wt-0",
      branch: "random-branch",
      path: "/repo/wt-0",
      branchOwned: true,
    }
    const state = {
      addSession: mock(() => {}),
      armAutoName: mock(() => {}),
      renameOwnedWorktree: mock(() => true),
    }
    const client = {
      branchName: { generate: mock(async () => ({ data: { branch: null } })) },
      experimental: { controlPlane: { moveSession: mock(async () => undefined) } },
    }
    const ctx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => ({ renameWorktree: mock(async () => ({ branch: "unused", path: "unused" })) }),
    } as unknown as ProjectContext
    const host = {
      log: () => {},
      post: () => {},
      createOnDisk: async () =>
        ({
          worktree: row,
          result: { path: row.path, branch: row.branch, parentBranch: "main" },
        }) as CreateWorktreeOnDiskResult,
      metadata: async () => ({}),
      client: () => client,
      hasScript: () => false,
      runSetup: async () => undefined,
      createSession: async () => ({ id: "session-0" }) as Session,
      autoName: () => ({ enabled: true, prefix: "" }),
      register: () => {},
      notifyReady: () => {},
      sessions: { register: () => {} },
      promptName: () => {},
      capture: () => {},
      error: () => {},
      discard: async () => {},
    } as unknown as MultiVersionHost

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Vague request",
      versions: 1,
    })

    expect(state.armAutoName).toHaveBeenCalledWith("wt-0", "session-0")
    expect(state.renameOwnedWorktree).not.toHaveBeenCalled()
  })

  it("generates one shared name with distinct model payloads and per-session paths", async () => {
    const rows = [
      { id: "wt-0", branch: "random-0", path: "/repo/wt-0", branchOwned: true },
      { id: "wt-1", branch: "random-1", path: "/repo/wt-1", branchOwned: true },
    ]
    const state = {
      addSession: mock(() => {}),
      armAutoName: mock(() => {}),
      renameOwnedWorktree: mock((_id: string, _current: string, _branch: string, _path: string) => true),
    }
    const generated = mock(async (input: unknown) => ({ data: { branch: "Fix Shared Name" } }))
    const moves: unknown[] = []
    const prompts: unknown[] = []
    const names: string[] = []
    const client = {
      branchName: { generate: generated },
      experimental: { controlPlane: { moveSession: mock(async (input: unknown) => moves.push(input)) } },
    }
    const manager = {
      renameWorktree: mock(async (source: string, _current: string, branch: string) => {
        const index = source.endsWith("wt-1") ? 1 : 0
        names.push(branch)
        return { branch, path: `/repo/named-${index}` }
      }),
      removeWorktree: mock(async () => {}),
    }
    let index = 0
    const messages: Array<Record<string, unknown>> = []
    const ctx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => manager,
    } as unknown as ProjectContext
    const host = {
      log: () => {},
      post: (message: Record<string, unknown>) => {
        messages.push(message)
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
      client: () => client,
      hasScript: () => false,
      runSetup: async () => undefined,
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

    await createMultiVersion(ctx, host, {
      type: "agentManager.createMultiVersion",
      text: "Fix Shared Name",
      versions: 2,
      modelAllocations: [
        { providerID: "provider-a", modelID: "model-a", count: 1 },
        { providerID: "provider-b", modelID: "model-b", count: 1 },
      ],
    })

    expect(generated).toHaveBeenCalledTimes(1)
    expect(generated).toHaveBeenCalledWith(
      {
        directory: "/repo/wt-0",
        sessionID: "session-0",
        prompt: "Fix Shared Name",
        providerID: "provider-a",
        modelID: "model-a",
      },
      expect.objectContaining({ throwOnError: true, signal: expect.any(AbortSignal) }),
    )
    expect(names).toEqual(["feat/fix-shared-name", "feat/fix-shared-name_v2"])
    expect(moves).toEqual([
      { sessionID: "session-0", destination: { directory: "/repo/named-0" }, moveChanges: false },
      { sessionID: "session-1", destination: { directory: "/repo/named-1" }, moveChanges: false },
    ])
    expect(prompts).toEqual([
      expect.objectContaining({ sessionId: "session-0", providerID: "provider-a", modelID: "model-a" }),
      expect.objectContaining({ sessionId: "session-1", providerID: "provider-b", modelID: "model-b" }),
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
      removeSession: mock(() => {}),
    }
    let index = 0
    let firstMove = true
    const prompts: string[] = []
    const deleted: unknown[] = []
    const client = {
      branchName: { generate: mock(async () => ({ data: { branch: "Fix Shared Name" } })) },
      experimental: {
        controlPlane: {
          moveSession: mock(async ({ sessionID }: { sessionID: string }) => {
            if (firstMove) {
              firstMove = false
              throw new Error("move refused")
            }
            return { data: { sessionID } }
          }),
        },
      },
      session: {
        abort: mock(async (input: unknown) => {
          expect(input).toEqual({ sessionID: "session-0", directory: "/repo/wt-0" })
          return { data: true }
        }),
        delete: mock(async (input: unknown) => {
          deleted.push(input)
          return { data: true }
        }),
      },
      backgroundProcess: { stopSession: mock(async () => ({})) },
    }
    const manager = {
      renameWorktree: mock(async (source: string, _current: string, branch: string) => {
        if (source.endsWith("fix-shared-name")) throw new Error("rollback refused")
        const item = rows.find((row) => row.path === source)!
        return { branch, path: `${item.path}-named` }
      }),
      removeWorktree: mock(async () => {}),
    }
    const stateCtx = {
      id: "project-1",
      stateManager: () => state,
      peekState: () => state,
      worktreeManager: () => manager,
    } as unknown as ProjectContext
    const messages: Array<Record<string, unknown>> = []
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
      client: () => client,
      hasScript: () => false,
      runSetup: async () => undefined,
      createSession: async (_dir: string, _branch: string, id: string) =>
        ({ id: `session-${id.slice(-1)}` }) as Session,
      autoName: () => ({ enabled: true, prefix: "feat" }),
      register: mock(() => {}),
      notifyReady: mock(() => {}),
      sessions: {
        register: mock(() => {}),
        abort: mock(async () => {}),
        forget: mock(() => {}),
        clearDirectory: mock(() => {}),
        setSessionDirectory: mock(() => {}),
        directories: () => new Map(),
      },
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
    expect(client.session.abort).toHaveBeenCalledWith(
      { sessionID: "session-0", directory: "/repo/wt-0" },
      { throwOnError: true },
    )
    expect(host.sessions.abort).not.toHaveBeenCalled()
    expect(deleted).toEqual([{ sessionID: "session-0", directory: "/repo/wt-0" }])
    expect(host.discard).not.toHaveBeenCalled()
    expect(messages.at(-1)).toEqual(
      expect.objectContaining({ type: "agentManager.multiVersionProgress", status: "done", completed: 1 }),
    )
  })
})
