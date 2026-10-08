// fork_change - new file
import { onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { ExtensionMessage, FileAttachment, WebviewMessage } from "../types/messages"
import { buildCommitAttachments, findCommitHashes } from "./git-commits-context-utils"
import { createContextRequests } from "./context-requests"

interface VSCodeContext {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

export function useGitCommitsContext(vscode: VSCodeContext, git?: Accessor<boolean>) {
  const requests = createContextRequests("git-commit-context", 60_000, "Timed out while reading git commits")

  const unsubscribe = vscode.onMessage((message) => {
    if (message.type === "gitCommitContextResult") {
      requests.settle(message.requestId, (request) => request.resolve(message.content))
      return
    }
    if (message.type === "gitCommitContextError") {
      requests.settle(message.requestId, (request) => request.reject(new Error(message.error)))
    }
  })

  onCleanup(() => {
    unsubscribe()
    requests.dispose("Git commit context request cancelled", true)
  })

  const resolveAttachments = async (text: string, sessionID?: string): Promise<FileAttachment[]> => {
    if (git?.() === false) return []
    const hashes = findCommitHashes(text)
    if (hashes.length === 0) return []

    const contents = await Promise.all(
      hashes.map((hash) =>
        requests.request((requestId) => {
          vscode.postMessage({ type: "requestGitCommitContext", requestId, hash, sessionID })
        }),
      ),
    )
    return buildCommitAttachments(
      text,
      hashes.map((hash, index) => ({ hash, content: contents[index] ?? "" })),
    )
  }

  return { pending: requests.pending, resolveAttachments }
}
