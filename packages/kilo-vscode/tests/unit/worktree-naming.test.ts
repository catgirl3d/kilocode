import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { generateFromPrompt, renameFromPrompt } from "../../src/agent-manager/worktree-naming"
import { WorktreeRollbackError } from "../../src/agent-manager/WorktreeManager"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"

describe("worktree naming", () => {
  let root: string
  let state: WorktreeStateManager
  let flow: string[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-naming-test-"))
    flow = []
    state = new WorktreeStateManager(root, (message) => {
      if (message.startsWith("Automatically renamed worktree")) flow.push("state")
    })
  })

  afterEach(async () => {
    await state.flush()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function addWorktree(owned = true) {
    const worktree = state.addWorktree({
      branch: "random-branch",
      path: path.join(root, "random-branch"),
      parentBranch: "main",
      branchOwned: owned,
    })
    state.addSession("session-1", worktree.id)
    return worktree
  }

  it("generates a branch through the endpoint with a bounded signal", async () => {
    const calls: unknown[] = []
    const client = {
      branchName: {
        generate: async (input: unknown, options: unknown) => {
          calls.push(input, options)
          return { data: { branch: "fix-token-refresh" } }
        },
      },
    }

    const result = await generateFromPrompt(
      client,
      { directory: "/repo/worktree", sessionID: "session-1", prompt: "Fix the token refresh" },
      () => undefined,
    )

    expect(result).toBe("fix-token-refresh")
    expect(calls[0]).toEqual({
      directory: "/repo/worktree",
      sessionID: "session-1",
      prompt: "Fix the token refresh",
    })
    expect(calls[1]).toMatchObject({ throwOnError: true, signal: expect.any(AbortSignal) })
  })

  it("returns null when generation returns no branch", async () => {
    const result = await generateFromPrompt(
      { branchName: { generate: async () => ({ data: { branch: null } }) } },
      { directory: "/repo/worktree", sessionID: "session-1", prompt: "hello" },
      () => undefined,
    )

    expect(result).toBeNull()
  })

  it("logs generation failures and returns null", async () => {
    const logs: string[] = []
    const result = await generateFromPrompt(
      {
        branchName: {
          generate: async () => {
            throw new Error("endpoint unavailable")
          },
        },
      },
      { directory: "/repo/worktree", sessionID: "session-1", prompt: "hello" },
      (message) => logs.push(message),
    )

    expect(result).toBeNull()
    expect(logs.some((message) => message.includes("endpoint unavailable"))).toBe(true)
  })

  it("renames the branch and directory before updating state", async () => {
    const worktree = addWorktree()
    flow = []
    const renames: Array<{ path: string; current: string; requested: string }> = []
    const moves: unknown[] = []
    const client = {
      experimental: {
        controlPlane: {
          moveSession: async (input: unknown) => {
            flow.push("move")
            moves.push(input)
          },
        },
      },
    }

    const result = await renameFromPrompt({
      client,
      manager: {
        renameWorktree: async (path, current, requested) => {
          flow.push("rename")
          renames.push({ path, current, requested })
          return { branch: requested, path: "/repo/worktrees/feat/fix-token-refresh" }
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix!!! Token refresh",
      prefix: "feat",
      log: () => undefined,
    })

    expect(result).toEqual({ branch: "feat/fix-token-refresh", path: "/repo/worktrees/feat/fix-token-refresh" })
    expect(renames).toEqual([
      {
        path: path.join(root, "random-branch"),
        current: "random-branch",
        requested: "feat/fix-token-refresh",
      },
    ])
    expect(moves).toEqual([
      {
        sessionID: "session-1",
        destination: { directory: "/repo/worktrees/feat/fix-token-refresh" },
        moveChanges: false,
      },
    ])
    expect(flow).toEqual(["rename", "move", "state"])
    expect(state.getWorktree(worktree.id)).toMatchObject({
      branch: "feat/fix-token-refresh",
      path: "/repo/worktrees/feat/fix-token-refresh",
    })
  })

  it("adds a version suffix after semantic naming", async () => {
    const worktree = addWorktree()
    const requested: string[] = []

    const result = await renameFromPrompt({
      client: {
        experimental: { controlPlane: { moveSession: async () => undefined } },
      },
      manager: {
        renameWorktree: async (_path, _current, branch) => {
          requested.push(branch)
          return { branch, path: "/repo/worktrees/renamed" }
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      version: { index: 1, total: 2 },
      log: () => undefined,
    })

    expect(requested).toEqual(["fix-auth-flow_v2"])
    expect(result?.branch).toBe("fix-auth-flow_v2")
  })

  it("keeps state unchanged when the worktree rename fails", async () => {
    const worktree = addWorktree()
    const moves: unknown[] = []
    const result = await renameFromPrompt({
      client: { experimental: { controlPlane: { moveSession: async (input: unknown) => moves.push(input) } } },
      manager: {
        renameWorktree: async () => {
          throw new Error("rename refused")
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: () => undefined,
    })

    expect(result).toBeNull()
    expect(moves).toEqual([])
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })
  })

  it("rethrows an incomplete initial rollback instead of treating naming as skipped", async () => {
    const worktree = addWorktree()
    const fatal = new WorktreeRollbackError("initial restore is ambiguous")

    await expect(
      renameFromPrompt({
        client: { experimental: { controlPlane: { moveSession: async () => undefined } } },
        manager: {
          renameWorktree: async () => {
            throw fatal
          },
        },
        state,
        worktree,
        sessionID: "session-1",
        generated: "Fix auth flow",
        prefix: "",
        log: () => undefined,
      }),
    ).rejects.toBe(fatal)
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })
  })

  it("rolls back the rename when moving the session fails", async () => {
    const worktree = addWorktree()
    const renames: Array<{ path: string; current: string; requested: string }> = []
    let moves = 0
    let calls = 0
    const logs: string[] = []
    const result = await renameFromPrompt({
      client: {
        experimental: {
          controlPlane: {
            moveSession: async () => {
              moves++
              throw new Error("move refused")
            },
          },
        },
      },
      manager: {
        renameWorktree: async (path, current, requested) => {
          calls++
          renames.push({ path, current, requested })
          return calls === 1
            ? { branch: requested, path: "/repo/worktrees/fix-auth-flow" }
            : { branch: worktree.branch, path: worktree.path }
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: (message) => logs.push(message),
    })

    expect(result).toBeNull()
    expect(moves).toBe(1)
    expect(renames).toEqual([
      { path: worktree.path, current: worktree.branch, requested: "fix-auth-flow" },
      { path: "/repo/worktrees/fix-auth-flow", current: "fix-auth-flow", requested: "random-branch" },
    ])
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })
    expect(logs.some((message) => message.includes("move refused"))).toBe(true)
  })

  it.each([
    {
      label: "an alternate branch with the original path",
      branch: "random-branch-2",
      path: "original",
    },
    {
      label: "the original branch with an alternate path",
      branch: "random-branch",
      path: "/repo/worktrees/random-branch-2",
    },
    {
      label: "an alternate branch and path",
      branch: "random-branch-2",
      path: "/repo/worktrees/random-branch-2",
    },
  ])("rejects a rollback that succeeds at $label", async ({ branch, path: alternatePath }) => {
    const worktree = addWorktree()
    const original = { branch: "random-branch", path: path.join(root, "random-branch") }
    const renamed = { branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }
    const alternate = { branch, path: alternatePath === "original" ? original.path : alternatePath }
    const renames: Array<{ path: string; current: string; requested: string }> = []
    let moves = 0
    let calls = 0
    const result = renameFromPrompt({
      client: {
        experimental: {
          controlPlane: {
            moveSession: async () => {
              moves++
              throw new Error("move refused")
            },
          },
        },
      },
      manager: {
        renameWorktree: async (path, current, requested) => {
          calls++
          renames.push({ path, current, requested })
          return calls === 1 ? renamed : alternate
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: () => undefined,
    })

    await expect(result).rejects.toThrow(/rollback returned/)
    expect(moves).toBe(1)
    expect(renames).toEqual([
      { path: original.path, current: original.branch, requested: "fix-auth-flow" },
      { path: renamed.path, current: renamed.branch, requested: original.branch },
    ])
    expect(state.getWorktree(worktree.id)).toMatchObject(alternate)
  })

  it("reconciles state when the rollback also fails", async () => {
    const worktree = addWorktree()
    const logs: string[] = []
    const renamed = { branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }
    let calls = 0
    const result = renameFromPrompt({
      client: {
        experimental: {
          controlPlane: {
            moveSession: async () => {
              throw new Error("move refused")
            },
          },
        },
      },
      manager: {
        renameWorktree: async () => {
          calls++
          if (calls === 2) throw new Error("rollback refused")
          return renamed
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: (message) => logs.push(message),
    })

    await expect(result).rejects.toThrow(/move refused.*rollback refused/)
    expect(state.getWorktree(worktree.id)).toMatchObject(renamed)
    expect(logs.some((message) => message.includes("rollback failed") && message.includes("rollback refused"))).toBe(
      true,
    )
  })

  it("propagates an incomplete reverse rollback without inventing a renamed state", async () => {
    const worktree = addWorktree()
    const fatal = new WorktreeRollbackError("reverse restore is ambiguous")
    let calls = 0

    await expect(
      renameFromPrompt({
        client: {
          experimental: {
            controlPlane: {
              moveSession: async () => {
                throw new Error("move refused")
              },
            },
          },
        },
        manager: {
          renameWorktree: async () => {
            calls++
            if (calls === 2) throw fatal
            return { branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }
          },
        },
        state,
        worktree,
        sessionID: "session-1",
        generated: "Fix auth flow",
        prefix: "",
        log: () => undefined,
      }),
    ).rejects.toBe(fatal)
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })
  })

  it("does not update state until the backend session move succeeds", async () => {
    const worktree = addWorktree()
    const moved = Promise.withResolvers<void>()
    const result = renameFromPrompt({
      client: {
        experimental: {
          controlPlane: {
            moveSession: async () => moved.promise,
          },
        },
      },
      manager: {
        renameWorktree: async () => ({ branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }),
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: () => undefined,
    })

    await Promise.resolve()
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })

    moved.resolve()
    await expect(result).resolves.toEqual({ branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" })
    expect(state.getWorktree(worktree.id)).toMatchObject({
      branch: "fix-auth-flow",
      path: "/repo/worktrees/fix-auth-flow",
    })
  })

  it("skips unowned worktrees without renaming", async () => {
    const worktree = addWorktree(false)
    let called = false
    const result = await renameFromPrompt({
      client: { experimental: { controlPlane: { moveSession: async () => undefined } } },
      manager: {
        renameWorktree: async () => {
          called = true
          return { branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }
        },
      },
      state,
      worktree,
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: () => undefined,
    })

    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it("returns the moved worktree when state reconciliation reports an inconsistency", async () => {
    const result = await renameFromPrompt({
      client: { experimental: { controlPlane: { moveSession: async () => undefined } } },
      manager: {
        renameWorktree: async () => ({ branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }),
      },
      state,
      worktree: { id: "missing", path: "/repo/worktrees/random-branch", branch: "random-branch", branchOwned: true },
      sessionID: "session-1",
      generated: "Fix auth flow",
      prefix: "",
      log: () => undefined,
    })

    expect(result).toEqual({ branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" })
  })
})
