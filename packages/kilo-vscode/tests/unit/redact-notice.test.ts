import { describe, expect, it } from "bun:test"
import * as RedactNotice from "../../webview-ui/src/utils/redact-notice"

// Synthetic keys only, assembled at runtime.
const key = "sk-" + "a".repeat(40)
const github = "ghp_" + "b".repeat(36)

describe("redact notice", () => {
  it("counts every secret the outbound filter hides", () => {
    expect(RedactNotice.count([`token ${key} and ${github}`])).toBe(2)
    expect(RedactNotice.count([`CLERK_SECRET_KEY=${key}`, "plain text"])).toBe(1)
    expect(RedactNotice.count(["plain text"])).toBe(0)
  })

  it("does not count markers that were already in the text", () => {
    expect(RedactNotice.count(["already [redacted] here"])).toBe(0)
  })

  it("reads the global policy like the CLI: absent means on", () => {
    expect(RedactNotice.redacting(undefined)).toBe(true)
    expect(RedactNotice.redacting({})).toBe(true)
    expect(RedactNotice.redacting({ experimental: { redact_secrets: true } })).toBe(true)
    expect(RedactNotice.redacting({ experimental: { redact_secrets: false } })).toBe(false)
  })

  it("takes the user text the CLI sends, synthetic file text included", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "text", text: "file body", synthetic: true },
      { type: "text", text: "skipped", ignored: true },
      { type: "text", text: "" },
      { type: "file", mime: "image/png" },
    ]
    expect(RedactNotice.user(parts)).toEqual(["hello", "file body"])
  })

  it("takes tool output unless compaction cleared it", () => {
    const done = { type: "tool", state: { status: "completed", output: "out", time: {} } }
    const cleared = { type: "tool", state: { status: "completed", output: "out", time: { compacted: 1 } } }
    const failed = { type: "tool", state: { status: "error", error: "boom" } }
    const interrupted = {
      type: "tool",
      state: { status: "error", error: "boom", metadata: { interrupted: true, output: "partial" } },
    }
    const running = { type: "tool", state: { status: "running" } }
    expect(RedactNotice.tool(done)).toEqual(["out"])
    expect(RedactNotice.tool(cleared)).toEqual([])
    expect(RedactNotice.tool(failed)).toEqual(["boom"])
    expect(RedactNotice.tool(interrupted)).toEqual(["partial"])
    expect(RedactNotice.tool(running)).toEqual([])
    expect(RedactNotice.tool({ type: "text", text: "x" })).toEqual([])
  })
})
