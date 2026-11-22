/**
 * Source contract for MessageList queue state.
 *
 * The unit-test DOM cannot exercise the server-snapshot preference, so guard
 * the wiring that uses the snapshot and clears it after disconnect.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = fs.readFileSync(path.join(root, "webview-ui/src/components/chat/MessageList.tsx"), "utf-8")

describe("MessageList queue wiring", () => {
  it("prefers server queue snapshots over inferred IDs", () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*\bserverQueue\b[\s\S]*\}\s*from\s*["']\.\.\/\.\.\/context\/session-queue["']/,
    )
    const memo = source.match(/const queuedIDs = createMemo\(\(\) => \{([\s\S]*?)\n  \}\)/)
    expect(memo?.[1]).toMatch(/if\s*\(ids\)\s*return\s+new Set\(serverQueue\(ids,/)
  })

  it("clears server queue snapshots when disconnected", () => {
    expect(source).toMatch(
      /createEffect\(\(\) => \{\s*if \(server\.isConnected\(\)\) return\s*setQueued\(\{\}\)\s*\}\)/,
    )
  })
})
