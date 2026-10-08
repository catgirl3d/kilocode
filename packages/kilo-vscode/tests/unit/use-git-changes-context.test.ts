import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { useGitChangesContext } from "../../webview-ui/src/hooks/useGitChangesContext"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

describe("useGitChangesContext", () => {
  it("returns the git-changes file attachment while preserving session and Agent Manager scope", async () => {
    const handlers = new Set<(message: ExtensionMessage) => void>()
    const posted: unknown[] = []
    const vscode = {
      postMessage: (message: WebviewMessage) => posted.push(message),
      onMessage: (handler: (message: ExtensionMessage) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    }
    let dispose = () => {}
    let context!: ReturnType<typeof useGitChangesContext>
    createRoot((cleanup) => {
      dispose = cleanup
      context = useGitChangesContext(
        vscode,
        () => "worktree-1",
        () => true,
      )
    })

    try {
      const text = "Review @git-changes"
      const pending = context.resolveAttachment(text, "session-7", "worktree-override")
      expect(posted).toMatchObject([
        {
          type: "requestGitChangesContext",
          sessionID: "session-7",
          agentManagerContext: "worktree-override",
        },
      ])
      const request = posted[0] as { requestId: string }
      for (const handler of handlers) {
        handler({
          type: "gitChangesContextResult",
          requestId: request.requestId,
          content: " M src/app.ts",
        })
      }

      const file = await pending
      expect(file?.filename).toBe("git-changes.txt")
      expect(file?.source?.text).toEqual({ value: "@git-changes", start: 7, end: 19 })
      expect(decodeURIComponent(file?.url.split(",").at(1) ?? "")).toBe(" M src/app.ts")
    } finally {
      dispose()
    }
  })
})
