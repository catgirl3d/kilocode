import { describe, expect, it } from "bun:test"
import path from "node:path"
import { formatMissingBlock, groupAddedLines, scope } from "./fork-audit"

const root = path.resolve(import.meta.dir, "..")
const script = path.join(root, "script", "fork-audit.ts")

function run(args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", script, ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = `${Buffer.from(result.stdout).toString("utf8")}\n${Buffer.from(result.stderr).toString("utf8")}`
  return { code: result.exitCode, out }
}

describe("fork audit historical markers", () => {
  it("accepts upstream kilocode new-file headers on existing Kilo files", () => {
    for (const file of [
      "packages/opencode/src/kilocode/bash-hierarchy.ts",
      "packages/opencode/src/kilocode/snapshot/track.ts",
    ]) {
      const result = run(["--worktree", "--base=upstream/main", file])
      expect(result.code).toBe(0)
      expect(result.out).not.toContain("whole-file marker used on existing upstream file")
    }
  }, 30_000)

  it("keeps committed audits on upstream main by default", () => {
    const result = run(["packages/core/src/pty/pty.bun.ts"])

    expect(result.out).toContain("committed history (upstream/main...HEAD)")
  })
})

describe("scope", () => {
  it("uses HEAD for a worktree audit without an explicit base", () => {
    expect(scope(["--worktree"])).toEqual({ base: "HEAD", worktree: true, ref: "HEAD", explicit: false })
  })

  it("uses an explicit base for a worktree audit", () => {
    expect(scope(["--worktree", "--base=origin/main"])).toEqual({
      base: "origin/main",
      worktree: true,
      ref: "origin/main",
      explicit: true,
    })
  })

  it("uses upstream history for a committed audit", () => {
    expect(scope([])).toEqual({ base: "upstream/main", worktree: false, ref: "upstream/main...HEAD", explicit: false })
  })
})

describe("groupAddedLines", () => {
  const covered = new Set([2, 3, 4])
  const fileLines = ["a", "b", "c", "d", "e", "f", "g", "h", "i"]

  it("splits contiguous added lines into blocks and flags uncovered lines", () => {
    const blocks = groupAddedLines([1, 2, 3, 4, 8, 9], fileLines, covered)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 4, isCovered: false, uncoveredLines: [1] })
    expect(blocks[1]).toMatchObject({ startLine: 8, endLine: 9, isCovered: false, uncoveredLines: [8, 9] })
  })

  it("marks a block as covered only when every line is inside a marker range", () => {
    const blocks = groupAddedLines([2, 3, 4], fileLines, covered)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 4, isCovered: true, uncoveredLines: [] })
  })

  it("keeps the whole contiguous run in one block even when only its tail is uncovered", () => {
    const blocks = groupAddedLines([2, 3, 4, 5], fileLines, covered)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 5, isCovered: false, uncoveredLines: [5] })
  })
})

describe("formatMissingBlock", () => {
  it("lists uncovered line numbers with their source text instead of the whole block", () => {
    const block = {
      startLine: 10,
      endLine: 13,
      lines: ["// fork_change start", "", "         </Card>", "// fork_change end"],
      uncoveredLines: [11, 12],
      isCovered: false,
    }

    const out = formatMissingBlock(block)

    expect(out[0]).toContain("[MISSING] L10-L13")
    expect(out[0]).toContain("2 uncovered lines")
    expect(out.some((line) => line.includes("L11: (blank line)"))).toBe(true)
    expect(out.some((line) => line.includes("L12:") && line.includes("</Card>"))).toBe(true)
    expect(out.some((line) => line.includes("fork_change start"))).toBe(false)
  })

  it("reports a single uncovered line with singular wording", () => {
    const block = {
      startLine: 3,
      endLine: 5,
      lines: ["// fork_change end", "", 'type AgentView = "list" | "create" | "edit"'],
      uncoveredLines: [4],
      isCovered: false,
    }

    const out = formatMissingBlock(block)

    expect(out[0]).toContain("1 uncovered line")
    expect(out.some((line) => line.includes("L4: (blank line)"))).toBe(true)
  })

  it("caps the preview and reports the remaining count", () => {
    const block = {
      startLine: 1,
      endLine: 7,
      lines: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"],
      uncoveredLines: [1, 2, 3, 4, 5, 6, 7],
      isCovered: false,
    }

    const out = formatMissingBlock(block)

    expect(out.filter((line) => line.startsWith("     L"))).toHaveLength(5)
    expect(out.at(-1)).toContain("... (2 more uncovered lines)")
  })
})
