import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { generateFromPrompt, renameFromPrompt } from "../../src/agent-manager/worktree-naming"
import { WorktreeRollbackError } from "../../src/agent-manager/WorktreeManager"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"

describe("worktree naming", () => {
  let root: string
  let state: WorktreeStateManager

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-naming-test-"))
    state = new WorktreeStateManager(root, () => undefined)
  })

  afterEach(async () => {
    await state.flush()
    fs.rmSync(root, { recursive: true, force: true })
  })

  function addWorktree(owned = true) {
    return state.addWorktree({
      branch: "random-branch",
      path: path.join(root, "random-branch"),
      parentBranch: "main",
      branchOwned: owned,
    })
  }

  function makeClient(branch: string | null = "fix-token-refresh") {
    const calls: string[] = []
    const options: unknown[] = []
    const out = {
      session: {
        create: mock(async (input: { directory: string }, option: unknown) => {
          options.push(option)
          calls.push(`create:${input.directory}`)
          return { data: { id: "scratch-session" } }
        }),
        delete: mock(async (input: { sessionID: string; directory: string }, option: unknown) => {
          options.push(option)
          calls.push(`delete:${input.sessionID}:${input.directory}`)
          return {}
        }),
      },
      branchName: {
        generate: mock(async (input: { directory: string; sessionID: string; prompt: string }, option: unknown) => {
          options.push(option)
          calls.push(`generate:${input.directory}:${input.sessionID}:${input.prompt}`)
          return { data: { branch } }
        }),
      },
    }
    return { calls, options, client: out as never }
  }

  it("creates and deletes a scratch session around generation", async () => {
    const logs: string[] = []
    const first = makeClient()
    const second = makeClient()

    const result = await generateFromPrompt(
      first.client,
      { prompt: "Fix the token refresh", providerID: "provider-a", modelID: "model-a" },
      (message) => logs.push(message),
    )
    await generateFromPrompt(second.client, { prompt: "Fix auth" }, () => {})

    const firstScratch = first.calls[0]!.slice("create:".length)
    const secondScratch = second.calls[0]!.slice("create:".length)
    expect(result).toBe("fix-token-refresh")
    expect(first.calls).toEqual([
      `create:${firstScratch}`,
      `generate:${firstScratch}:scratch-session:Fix the token refresh`,
      `delete:scratch-session:${firstScratch}`,
    ])
    expect(firstScratch).toContain(path.join(os.tmpdir(), "kilo-worktree-naming-"))
    expect(secondScratch).not.toBe(firstScratch)
    expect(fs.existsSync(firstScratch)).toBe(false)
    expect(fs.existsSync(secondScratch)).toBe(false)
    expect(first.options).toHaveLength(3)
    expect(first.options.every((option) => option && typeof option === "object" && "signal" in option)).toBe(true)
    expect(logs).toEqual([])
  })

  it("logs scratch session delete failures without failing generation", async () => {
    const logs: string[] = []
    const { client } = makeClient()
    client.session.delete.mockRejectedValue(new Error("delete refused"))

    await expect(
      generateFromPrompt(client, { prompt: "Fix the token refresh" }, (message) => logs.push(message)),
    ).resolves.toBe("fix-token-refresh")
    expect(client.session.delete).toHaveBeenCalledTimes(2)
    expect(logs.some((message) => message.includes("delete refused"))).toBe(true)
  })

  it("logs generation failures and still deletes the scratch session", async () => {
    const logs: string[] = []
    const { calls, client } = makeClient()
    client.branchName.generate.mockRejectedValue(new Error("endpoint unavailable"))

    const result = await generateFromPrompt(client, { prompt: "Fix the token refresh" }, (message) =>
      logs.push(message),
    )

    expect(result).toBeNull()
    expect(calls[0]).toStartWith("create:")
    expect(calls.at(-1)).toStartWith("delete:")
    expect(logs.some((message) => message.includes("endpoint unavailable"))).toBe(true)
  })

  it("renames the branch and directory before updating state", async () => {
    const worktree = addWorktree()
    const original = { branch: worktree.branch, path: worktree.path }
    const flow: string[] = []
    const manager = {
      renameWorktree: mock(async (source: string, current: string, requested: string) => {
        flow.push(`rename:${source}:${current}:${requested}`)
        return { branch: requested, path: "/repo/worktrees/feat/fix-token-refresh" }
      }),
    }

    const result = await renameFromPrompt({
      manager,
      state,
      worktree,
      generated: "Fix!!! Token refresh",
      prefix: "feat",
      log: () => flow.push("log"),
    })

    expect(result).toEqual({ branch: "feat/fix-token-refresh", path: "/repo/worktrees/feat/fix-token-refresh" })
    expect(manager.renameWorktree).toHaveBeenCalledWith(original.path, original.branch, "feat/fix-token-refresh")
    expect(state.getWorktree(worktree.id)).toMatchObject({
      branch: "feat/fix-token-refresh",
      path: "/repo/worktrees/feat/fix-token-refresh",
    })
    expect(flow).toEqual([`rename:${original.path}:random-branch:feat/fix-token-refresh`])
  })

  it("retries transient rename failures", async () => {
    const worktree = addWorktree()
    let calls = 0
    const manager = {
      renameWorktree: mock(async () => {
        calls++
        if (calls < 3) throw new Error("lock")
        return { branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" }
      }),
    }

    const result = await renameFromPrompt({
      manager,
      state,
      worktree,
      generated: "Fix auth flow",
      prefix: "",
      log: () => {},
    })

    expect(result).toEqual({ branch: "fix-auth-flow", path: "/repo/worktrees/fix-auth-flow" })
    expect(calls).toBe(3)
  })

  it("adds a version suffix after semantic naming", async () => {
    const worktree = addWorktree()
    const requested: string[] = []
    const manager = {
      renameWorktree: mock(async (_path: string, _current: string, branch: string) => {
        requested.push(branch)
        return { branch, path: "/repo/worktrees/renamed" }
      }),
    }

    const result = await renameFromPrompt({
      manager,
      state,
      worktree,
      generated: "Fix auth flow",
      prefix: "",
      version: { index: 1, total: 2 },
      log: () => {},
    })

    expect(requested).toEqual(["fix-auth-flow_v2"])
    expect(result?.branch).toBe("fix-auth-flow_v2")
  })

  it("returns null after rename retries fail", async () => {
    const worktree = addWorktree()
    const logs: string[] = []
    const manager = {
      renameWorktree: mock(async () => {
        throw new Error("rename refused")
      }),
    }

    const result = await renameFromPrompt({
      manager,
      state,
      worktree,
      generated: "Fix auth flow",
      prefix: "",
      log: (message) => logs.push(message),
    })

    expect(result).toBeNull()
    expect(manager.renameWorktree).toHaveBeenCalledTimes(3)
    expect(logs.some((message) => message.includes("rename refused"))).toBe(true)
    expect(state.getWorktree(worktree.id)).toMatchObject({ branch: "random-branch", path: worktree.path })
  })

  it("rethrows WorktreeRollbackError immediately", async () => {
    const worktree = addWorktree()
    const fatal = new WorktreeRollbackError("rollback is ambiguous")
    const manager = {
      renameWorktree: mock(async () => {
        throw fatal
      }),
    }

    await expect(
      renameFromPrompt({ manager, state, worktree, generated: "Fix auth flow", prefix: "", log: () => {} }),
    ).rejects.toBe(fatal)
    expect(manager.renameWorktree).toHaveBeenCalledTimes(1)
  })

  it("does not rename unowned worktrees", async () => {
    const worktree = addWorktree(false)
    const manager = { renameWorktree: mock(async () => ({ branch: "fix-auth-flow", path: "/repo/fix-auth-flow" })) }

    await expect(
      renameFromPrompt({ manager, state, worktree, generated: "Fix auth flow", prefix: "", log: () => {} }),
    ).resolves.toBeNull()
    expect(manager.renameWorktree).not.toHaveBeenCalled()
  })
})
