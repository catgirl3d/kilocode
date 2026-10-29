import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { handleEditorAction } from "../../src/kilo-provider/editor-actions"

const external = spyOn(vscode.env, "openExternal")
const stat = spyOn(vscode.workspace.fs, "stat")
const execute = spyOn(vscode.commands, "executeCommand")

afterEach(() => {
  external.mockClear()
  stat.mockClear()
  execute.mockClear()
})

describe("Source session routing", () => {
  it("hands an attributed source session to the reveal command with its tracked directory", () => {
    const handled = handleEditorAction(
      { type: "openSourceSession", sessionID: "ses_fork" },
      { dir: () => "/repo", known: (id) => (id === "ses_fork" ? "/repo/.kilo/worktrees/feature" : undefined) },
    )

    expect(handled).toBe(true)
    expect(execute.mock.calls).toEqual([["kilo-code.new.revealSession", "ses_fork", "/repo/.kilo/worktrees/feature"]])
  })

  it("passes no directory for a session the provider does not track", () => {
    const handled = handleEditorAction(
      { type: "openSourceSession", sessionID: "ses_sidebar" },
      { dir: () => "/repo", known: () => undefined },
    )

    expect(handled).toBe(true)
    expect(execute.mock.calls).toEqual([["kilo-code.new.revealSession", "ses_sidebar", undefined]])
  })
})

describe("Markdown editor routing", () => {
  it("opens relative Markdown through the viewer and preserves coordinates", () => {
    const calls: unknown[][] = []

    handleEditorAction(
      { type: "openFile", filePath: "docs/rules.md", sessionID: "session-a", line: 8, column: 4 },
      {
        dir: () => "/worktree",
        openMarkdown: (...args) => {
          calls.push(args)
          return true
        },
      },
    )

    expect(calls).toEqual([["docs/rules.md", "session-a", 8, 4]])
  })

  it("keeps Markdown URLs, absolute paths, and home paths on native routing", () => {
    const calls: string[] = []
    const files = ["https://example.com/rules.md", path.join(os.tmpdir(), "rules.md"), "~/rules.md"]

    for (const file of files) {
      handleEditorAction(
        { type: "openFile", filePath: file },
        {
          dir: () => "/worktree",
          openMarkdown: (value) => {
            calls.push(value)
            return true
          },
        },
      )
    }

    expect(calls).toEqual([])
    expect(external).toHaveBeenCalledTimes(1)
    expect(external.mock.calls[0]?.[0]).toBeDefined()
    expect(stat).toHaveBeenCalledTimes(2)
  })
})
