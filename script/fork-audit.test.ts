import { describe, expect, it } from "bun:test"
import path from "node:path"

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
      const result = run(["--worktree", file])
      expect(result.code).toBe(0)
      expect(result.out).not.toContain("whole-file marker used on existing upstream file")
    }
  })

  it("does not inspect historical markers when the selected base is HEAD", () => {
    const result = run(["--worktree", "--base=HEAD", "packages/kilo-vscode/src/extension.ts"])

    expect(result.code).toBe(0)
    expect(result.out).not.toContain("[REDUNDANT]")
  })

  it("still reports a redundant fork marker", () => {
    const result = run(["--worktree", "packages/kilo-vscode/src/commands/toggle-auto-approve.ts"])

    expect(result.code).toBe(1)
    expect(result.out).toContain("[REDUNDANT]")
  })
})
