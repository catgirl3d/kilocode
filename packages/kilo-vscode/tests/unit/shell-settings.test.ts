import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const source = readFileSync(
  path.join(import.meta.dir, "../../webview-ui/src/components/settings/AgentBehaviourTab.tsx"),
  "utf8",
)

describe("shell settings", () => {
  it("resets custom mode before treating an already-automatic shell as a no-op", () => {
    const start = source.indexOf("  const selectShell = (next: ShellMode) => {")
    const end = source.indexOf("\n  const commitCustomShell", start)
    const body = source.slice(start, end)
    const auto = body.indexOf('    if (next === "auto") {')
    const reset = body.indexOf("      setCustomMode(false)", auto)
    const noOp = body.indexOf("      if (value === undefined) return", auto)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(reset).toBeGreaterThan(auto)
    expect(reset).toBeLessThan(noOp)
  })
})
