import { describe, expect, it } from "bun:test"
import * as path from "path"
import { editPaths } from "../../src/kilo-provider/session-edits"

describe("session edit paths", () => {
  it("ignores read tools and returns every file from mutating tools", () => {
    const parts = [
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "/workspace/app/vendor/readme.md" } },
      },
      {
        type: "tool",
        tool: "edit",
        state: { status: "completed", metadata: { filediff: { file: "/workspace/app/src/a.ts" } } },
      },
      {
        type: "tool",
        tool: "apply_patch",
        state: {
          status: "completed",
          metadata: {
            files: [
              { filePath: "/workspace/app/src/b.ts" },
              { filePath: "/workspace/app/src/old.ts", movePath: "/workspace/app/src/new.ts" },
            ],
          },
        },
      },
    ]

    // editPaths normalizes to platform-native separators.
    const expected = ["/workspace/app/src/a.ts", "/workspace/app/src/b.ts", "/workspace/app/src/new.ts"].map((file) =>
      path.normalize(file),
    )
    expect(editPaths(parts, "/workspace")).toEqual(expected)
  })
})
