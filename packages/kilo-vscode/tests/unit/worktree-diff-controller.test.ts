import { describe, it, expect } from "bun:test"
import { WorktreeDiffController } from "../../src/agent-manager/worktree-diff-controller"
import type { DiffSourceCatalog } from "../../src/diff/sources/catalog"
import type { DiffSource } from "../../src/diff/sources/types"
import type { DiffFile, PanelContext } from "../../src/diff/types"
import type { GitOps } from "../../src/agent-manager/GitOps"
import type { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"

// Records every PanelContext handed to catalog.build so tests can assert which
// base branch the active source was (re)built with. The controller, scope
// resolution, and SourceController lifecycle under test are all real.
// Contexts are worktree ids (the sidebar selection), not session ids.
type Opts = {
  fetch?: (n: number) => Promise<void>
  ready?: () => Promise<void> | undefined
  git?: GitOps
  trees?: Record<string, { id: string; path: string; parentBranch: string; remote: string }>
  diffs?: (id: string, ctx: PanelContext) => DiffFile[]
}

function make(opts: Opts = {}) {
  const builds: { id: string; ctx: PanelContext }[] = []
  const posted: unknown[] = []
  let fetches = 0
  const trees = opts.trees ?? {
    w1: { id: "w1", path: "/wt", parentBranch: "main", remote: "origin" },
    w2: { id: "w2", path: "/wt-2", parentBranch: "main", remote: "origin" },
  }
  const catalog = {
    build: (id: string, ctx: PanelContext): DiffSource => {
      builds.push({ id, ctx })
      return {
        descriptor: { id, type: "workspace", group: "Git", capabilities: { revert: true, comments: true } },
        async fetch() {
          await opts.fetch?.(++fetches)
          return { diffs: opts.diffs?.(id, ctx) ?? [] }
        },
      }
    },
  } as unknown as DiffSourceCatalog

  const state = {
    getSession: (id: string) => (id === "s1" ? { id: "s1", worktreeId: "w1", createdAt: "" } : undefined),
    getWorktree: (id: string) => trees[id],
  } as unknown as WorktreeStateManager

  const controller = new WorktreeDiffController({
    getState: () => state,
    getRoot: () => "/repo",
    getStateReady: opts.ready ?? (() => undefined),
    catalog,
    git: opts.git ?? ({} as GitOps),
    localDiffFile: async () => null,
    post: (message) => posted.push(message),
    log: () => {},
  })
  return { controller, builds, posted }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error("waitFor timed out")
}

function byType(items: unknown[], type: string) {
  return items.filter((item): item is { type: string } => {
    return typeof item === "object" && item !== null && (item as { type?: unknown }).type === type
  })
}

describe("WorktreeDiffController.setVisible", () => {
  it("defers hidden watches and resumes the latest base when shown", async () => {
    let fetches = 0
    const { controller, builds } = make({
      fetch: async () => {
        fetches++
      },
    })
    try {
      await controller.setVisible(false)
      controller.start("w1#branch")
      await waitFor(() => builds.length === 1)
      expect(fetches).toBe(0)
      await controller.setBase("w1#branch", "feature-x")
      expect(fetches).toBe(0)
      await controller.setVisible(true)
      expect(fetches).toBe(1)
      expect(builds.at(-1)?.ctx.baseBranch).toBe("feature-x")
      await controller.setVisible(false)
      await controller.request("w1#branch")
      expect(fetches).toBe(1)
      await controller.setVisible(true)
      expect(fetches).toBe(2)
    } finally {
      controller.stop()
    }
  })
})

describe("WorktreeDiffController.setBase", () => {
  it("rebuilds the active source against the overridden base branch", async () => {
    const { controller, builds, posted } = make()
    const resets = () => byType(posted, "agentManager.worktreeDiffLoading").filter((msg) => Object.hasOwn(msg, "reset"))
    controller.start("w1#branch")
    await waitFor(() => builds.length === 1)
    expect(builds[0]!.ctx.dir).toBe("/wt")
    expect(builds[0]!.ctx.baseBranch).toBe("origin/main")

    await controller.setBase("w1#branch", "feature-x")
    expect(builds.length).toBe(2)
    expect(builds[1]!.ctx.dir).toBe("/wt")
    expect(builds[1]!.ctx.baseBranch).toBe("feature-x")

    // Clearing the override falls back to the recorded parent ref.
    await controller.setBase("w1#branch", undefined)
    expect(builds.length).toBe(3)
    expect(builds[2]!.ctx.baseBranch).toBe("origin/main")
    expect(resets()).toHaveLength(3)
    await controller.request("w1#branch")
    expect(resets()).toHaveLength(3)
    await controller.requestFile("w2#branch", "a.ts")
    expect(byType(posted, "agentManager.worktreeDiffFile")).toHaveLength(0)

    controller.stop()
  })

  it("stores the override without rebuilding when the context isn't active", async () => {
    const { controller, builds } = make()

    await controller.setBase("w1#branch", "feature-x")
    expect(builds.length).toBe(0)

    // The next activation of that context resolves the stored override.
    controller.start("w1#branch")
    await waitFor(() => builds.length === 1)
    expect(builds[0]!.ctx.baseBranch).toBe("feature-x")

    controller.stop()
  })

  it("keeps watching when the base changes during the initial fetch", async () => {
    // Hold the first activation's fetch in flight, simulating a slow worktree
    // diff. isPolling is still false in this window, but the watch intent must
    // survive the base change rather than downgrading the panel to one-shot.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { controller, builds } = make({
      fetch: async (n) => {
        if (n === 1) await gate
      },
    })

    controller.start("w1#branch")
    await waitFor(() => builds.length === 1)

    const change = controller.setBase("w1#branch", "feature-x")
    release()
    await change
    expect(builds.length).toBe(2)
    expect(builds[1]!.ctx.baseBranch).toBe("feature-x")

    // Polling survives: start() early-returns for an id that is already
    // watched. A downgraded one-shot panel would re-activate and rebuild here.
    controller.start("w1#branch")
    await tick()
    expect(builds.length).toBe(2)

    controller.stop()
  })

  it("uses the latest activation when resolve finishes out of order", async () => {
    const a = Promise.withResolvers<void>()
    const b = Promise.withResolvers<void>()
    let calls = 0
    const git = {
      currentBranch: async () => {
        const wait = calls++ === 0 ? a : b
        await wait.promise
        return "feature"
      },
      resolveTrackingBranch: async () => "origin/main",
    } as unknown as GitOps
    const { controller, builds } = make({ git })

    controller.start("local#branch")
    await waitFor(() => calls === 1)
    controller.start("local#staged")
    await waitFor(() => calls === 2)

    b.resolve()
    await waitFor(() => builds.length === 1)
    a.resolve()
    await tick()

    expect(builds).toHaveLength(1)
    expect(builds[0]!.id).toBe("staged")

    controller.stop()
  })

  it("uses the latest request in an A-to-B-to-A sequence", async () => {
    const a1 = Promise.withResolvers<void>()
    const b = Promise.withResolvers<void>()
    const a2 = Promise.withResolvers<void>()
    const waits = [a1, b, a2]
    let calls = 0
    const git = {
      currentBranch: async () => {
        const wait = waits[calls++]!
        await wait.promise
        return "feature"
      },
      resolveTrackingBranch: async () => "origin/main",
    } as unknown as GitOps
    const { controller, builds } = make({ git })

    controller.start("local#branch")
    await waitFor(() => calls === 1)
    controller.start("local#staged")
    await waitFor(() => calls === 2)
    controller.start("local#branch")
    await waitFor(() => calls === 3)

    a2.resolve()
    await waitFor(() => builds.length === 1)
    b.resolve()
    a1.resolve()
    await tick()

    expect(builds).toHaveLength(1)
    expect(builds[0]!.id).toBe("workspace")

    controller.stop()
  })

  it("does not activate after a pending request is stopped", async () => {
    const ready = Promise.withResolvers<void>()
    const { controller, builds } = make({ ready: () => ready.promise })

    controller.start("w1#branch")
    controller.stop()
    ready.resolve()
    await tick()

    expect(builds).toHaveLength(0)
  })

  it("drops source data and polling from a stopped initial fetch", async () => {
    const fetch = Promise.withResolvers<void>()
    const { controller, builds, posted } = make({
      fetch: async () => {
        await fetch.promise
      },
      diffs: () => [{ file: "stale.ts", before: "", after: "", additions: 0, deletions: 0 }],
    })

    controller.start("w1#branch")
    await waitFor(() => builds.length === 1)
    controller.stop()
    fetch.resolve()
    await tick()

    expect(byType(posted, "agentManager.worktreeDiff")).toHaveLength(0)

    controller.start("w1#branch")
    await waitFor(() => builds.length === 2)
    controller.stop()
  })

  it("keeps synchronous repeated starts while the initial fetch is pending", async () => {
    const fetch = Promise.withResolvers<void>()
    const { controller, builds } = make({
      fetch: async (n) => {
        if (n === 1) await fetch.promise
      },
    })

    controller.start("w1#branch")
    await waitFor(() => builds.length === 1)
    controller.start("w1#branch")
    await waitFor(() => builds.length === 2)
    fetch.resolve()

    controller.stop()
  })
})

describe("WorktreeDiffController.apply", () => {
  const results = (posted: unknown[]) =>
    byType(posted, "agentManager.applyWorktreeDiffResult") as unknown as {
      status: string
      message: string
      conflicts?: { file?: string }[]
    }[]

  it("keeps the branch patch flow for the default mode", async () => {
    const calls: unknown[][] = []
    const git = {
      buildWorktreePatch: async (path: string, base: string, files: string[]) => {
        calls.push(["patch", path, base, files])
        return "patch-text"
      },
      checkApplyPatch: async () => ({ ok: true, conflicts: [], message: "clean" }),
      applyPatch: async () => ({ ok: true, conflicts: [], message: "applied" }),
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", ["a.ts"])

    expect(calls).toEqual([["patch", "/wt", "origin/main", ["a.ts"]]])
    expect(results(posted).at(-1)).toMatchObject({ status: "success" })
  })

  it("copies session files without building a patch in session mode", async () => {
    const calls: unknown[][] = []
    const git = {
      buildWorktreePatch: async () => {
        throw new Error("branch patch must not be built in session mode")
      },
      dirtyTargets: async () => [],
      copyWorktreeFiles: async (path: string, root: string, files: string[]) => {
        calls.push(["copy", path, root, files])
        return { applied: 2, failed: [] }
      },
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", ["a.ts", "b.ts"], "session")

    expect(calls).toEqual([["copy", "/wt", "/repo", ["a.ts", "b.ts"]]])
    const last = results(posted).at(-1)
    expect(last?.status).toBe("success")
    expect(last?.message).toContain("2")
  })

  it("reports partial session copies as an error", async () => {
    const git = {
      dirtyTargets: async () => [],
      copyWorktreeFiles: async () => ({ applied: 1, failed: [{ file: "b.ts", message: "denied" }] }),
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", ["a.ts", "b.ts"], "session")

    const last = results(posted).at(-1)
    expect(last?.status).toBe("error")
    expect(last?.message).toContain("b.ts")
  })

  it("requires an explicit file selection in session mode", async () => {
    let called = 0
    const git = {
      copyWorktreeFiles: async () => {
        called++
        return { applied: 0, failed: [] }
      },
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", undefined, "session")

    expect(called).toBe(0)
    const last = results(posted).at(-1)
    expect(last?.status).toBe("error")
    expect(last?.message).toContain("Select at least one file")
  })

  it("blocks the session copy when local files have uncommitted changes", async () => {
    const checks: unknown[][] = []
    let copies = 0
    const git = {
      dirtyTargets: async (path: string, root: string, files: string[]) => {
        checks.push([path, root, files])
        return ["b.ts"]
      },
      copyWorktreeFiles: async () => {
        copies++
        return { applied: 0, failed: [] }
      },
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", ["a.ts", "b.ts"], "session")

    expect(checks).toEqual([["/wt", "/repo", ["a.ts", "b.ts"]]])
    expect(copies).toBe(0)
    const last = results(posted).at(-1)
    expect(last?.status).toBe("conflict")
    expect(last?.conflicts?.map((entry) => entry.file)).toEqual(["b.ts"])
  })

  it("copies over local changes the user confirmed and still blocks the rest", async () => {
    let copies = 0
    const git = {
      dirtyTargets: async () => ["b.ts", "c.ts"],
      copyWorktreeFiles: async (_path: string, _root: string, files: string[]) => {
        copies++
        return { applied: files.length, failed: [] }
      },
    } as unknown as GitOps
    const { controller, posted } = make({ git })

    await controller.apply("w1", ["a.ts", "b.ts", "c.ts"], "session", ["b.ts"])
    const partial = results(posted).at(-1)
    expect(partial?.status).toBe("conflict")
    expect(partial?.conflicts?.map((entry) => entry.file)).toEqual(["c.ts"])
    expect(copies).toBe(0)

    await controller.apply("w1", ["a.ts", "b.ts", "c.ts"], "session", ["b.ts", "c.ts"])
    expect(copies).toBe(1)
    expect(results(posted).at(-1)).toMatchObject({ status: "success" })
  })
})
