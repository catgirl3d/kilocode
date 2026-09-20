import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { handleEditorAction } from "../../src/kilo-provider/editor-actions"

const external = spyOn(vscode.env, "openExternal")
const stat = spyOn(vscode.workspace.fs, "stat")

afterEach(() => {
  external.mockClear()
  stat.mockClear()
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
