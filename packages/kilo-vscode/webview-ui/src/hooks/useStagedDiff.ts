// fork_change - new file
import { onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../types/messages"
import { createContextRequests } from "./context-requests"

export type StagedDiffWrite = { path: string } | { empty: true }

interface VSCodeContext {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

export interface StagedDiff {
  pending: Accessor<boolean>
  /** Write `git diff --staged` to a file and return the workspace-relative path to attach. */
  write: (sessionID?: string) => Promise<StagedDiffWrite>
}

export function useStagedDiff(vscode: VSCodeContext): StagedDiff {
  const requests = createContextRequests("staged-diff", 15_000, "Timed out while writing staged diff")

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type === "stagedDiffResult") {
      // The shared request bookkeeping carries strings; an empty result means
      // the index had no staged changes and no file was written.
      requests.settle(message.requestId, (req) => req.resolve(message.path ?? ""))
      return
    }

    if (message.type === "stagedDiffError") {
      requests.settle(message.requestId, (req) => req.reject(new Error(message.error)))
    }
  })

  onCleanup(() => {
    unsubscribe()
    requests.dispose("Staged diff request cancelled", true)
  })

  const write = async (sessionID?: string) => {
    const path = await requests.request((requestId) => {
      vscode.postMessage({ type: "requestStagedDiff", requestId, sessionID })
    })
    return path === "" ? ({ empty: true } as const) : { path }
  }

  return { pending: requests.pending, write }
}
