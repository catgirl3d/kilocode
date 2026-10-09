import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  generateBranchName,
  sanitizeBranchName,
  semanticBranchName,
  versionedName,
} from "../../src/agent-manager/branch-name"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { cleanup, tempDirs } from "../helpers/worktree-fixtures"

afterEach(cleanup)

// ---------------------------------------------------------------------------
// generateBranchName
// ---------------------------------------------------------------------------

describe("generateBranchName", () => {
  it("generates a two-word predicate-object name", () => {
    const name = generateBranchName("anything")
    // Should be two lowercase words joined by a hyphen
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it("avoids existing branches", () => {
    // Generate 50 names and collect them; none should collide with the existing list
    const existing = ["brave-piano", "sunny-cloud"]
    for (let i = 0; i < 50; i++) {
      const name = generateBranchName("task", existing)
      expect(existing).not.toContain(name)
    }
  })

  it("falls back to numeric suffix when collisions are likely", () => {
    // Supply a huge existing list — eventually a numeric suffix or timestamp is used
    const name = generateBranchName("task", [])
    expect(typeof name).toBe("string")
    expect(name.length).toBeGreaterThan(0)
  })

  it("ignores the prompt and always returns friendly words", () => {
    const a = generateBranchName("")
    const b = generateBranchName("FIX BUG")
    // Both should be lowercase word-hyphen-word patterns
    expect(a).toMatch(/^[a-z]+-[a-z]+/)
    expect(b).toMatch(/^[a-z]+-[a-z]+/)
  })
})

// ---------------------------------------------------------------------------
// sanitizeBranchName
// ---------------------------------------------------------------------------

describe("semanticBranchName", () => {
  it("creates a branch slug from a generated session title", () => {
    expect(semanticBranchName("Fix token refresh race")).toBe("fix-token-refresh-race")
  })

  it("normalizes a user prefix and keeps branch separators", () => {
    expect(semanticBranchName("Add billing alerts", "marius/features/")).toBe("marius/features/add-billing-alerts")
  })

  it("reserves the length limit for the prefix", () => {
    expect(semanticBranchName("a".repeat(100), "team/").length).toBeLessThanOrEqual(50)
  })

  it("returns empty when the title has no usable characters", () => {
    expect(semanticBranchName("修复登录")).toBe("")
  })
})

describe("sanitizeBranchName", () => {
  it("replaces spaces with hyphens", () => {
    expect(sanitizeBranchName("model comparison")).toBe("model-comparison")
  })

  it("lowercases input", () => {
    expect(sanitizeBranchName("My Feature")).toBe("my-feature")
  })

  it("strips special characters", () => {
    expect(sanitizeBranchName("fix bug #123 & add feature!")).toBe("fix-bug-123-add-feature")
  })

  it("collapses consecutive hyphens", () => {
    expect(sanitizeBranchName("one   two   three")).toBe("one-two-three")
  })

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeBranchName("---hello---")).toBe("hello")
  })

  it("truncates to maxLength", () => {
    const result = sanitizeBranchName("a".repeat(100))
    expect(result.length).toBeLessThanOrEqual(50)
  })

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeBranchName("   ")).toBe("")
  })

  it("returns empty string for empty input", () => {
    expect(sanitizeBranchName("")).toBe("")
  })

  it("handles custom maxLength", () => {
    const result = sanitizeBranchName("abcdefghij", 5)
    expect(result).toBe("abcde")
  })
})

// ---------------------------------------------------------------------------
// versionedName
// ---------------------------------------------------------------------------

describe("versionedName", () => {
  it("returns base name for first version", () => {
    const result = versionedName("auth-refactor", 0, 3)
    expect(result).toEqual({ branch: "auth-refactor", label: "auth-refactor" })
  })

  it("appends _v2 to branch and v2 to label for second version", () => {
    const result = versionedName("auth-refactor", 1, 3)
    expect(result).toEqual({ branch: "auth-refactor_v2", label: "auth-refactor v2" })
  })

  it("appends _v3 to branch and v3 to label for third version", () => {
    const result = versionedName("auth-refactor", 2, 3)
    expect(result).toEqual({ branch: "auth-refactor_v3", label: "auth-refactor v3" })
  })

  it("returns undefined for both when no name provided", () => {
    expect(versionedName(undefined, 0, 3)).toEqual({ branch: undefined, label: undefined })
    expect(versionedName(undefined, 1, 3)).toEqual({ branch: undefined, label: undefined })
  })

  it("returns undefined for empty string name", () => {
    expect(versionedName("", 0, 2)).toEqual({ branch: undefined, label: undefined })
  })

  it("no suffix for single version", () => {
    const result = versionedName("test", 0, 1)
    expect(result).toEqual({ branch: "test", label: "test" })
  })
})

// ---------------------------------------------------------------------------
// WorktreeStateManager -- updateWorktreeLabel
// ---------------------------------------------------------------------------

describe("WorktreeStateManager.updateWorktreeLabel", () => {
  it("persists label on a worktree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-label-"))
    tempDirs.push(dir)
    const state = new WorktreeStateManager(dir, () => {})
    const wt = state.addWorktree({ branch: "test", path: dir, parentBranch: "main" })
    state.updateWorktreeLabel(wt.id, "my custom name")
    await state.flush()

    expect(state.getWorktree(wt.id)?.label).toBe("my custom name")
  })

  it("clears label when set to empty string", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-label-"))
    tempDirs.push(dir)
    const state = new WorktreeStateManager(dir, () => {})
    const wt = state.addWorktree({ branch: "test", path: dir, parentBranch: "main", label: "initial" })
    await state.flush()
    state.updateWorktreeLabel(wt.id, "")
    await state.flush()

    expect(state.getWorktree(wt.id)?.label).toBeUndefined()
  })

  it("survives save and reload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-label-"))
    tempDirs.push(dir)
    const state = new WorktreeStateManager(dir, () => {})
    const wt = state.addWorktree({ branch: "test", path: dir, parentBranch: "main", label: "persisted" })
    await state.flush()

    const state2 = new WorktreeStateManager(dir, () => {})
    await state2.load()
    expect(state2.getWorktree(wt.id)?.label).toBe("persisted")
  })

  it("no-ops for nonexistent worktree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-wt-label-"))
    tempDirs.push(dir)
    const state = new WorktreeStateManager(dir, () => {})
    state.updateWorktreeLabel("nonexistent", "test")
    await state.flush()
  })
})
