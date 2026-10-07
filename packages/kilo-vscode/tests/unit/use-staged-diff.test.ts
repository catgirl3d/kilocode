import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { useStagedDiff } from "../../webview-ui/src/hooks/useStagedDiff"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

type Posted = Extract<WebviewMessage, { type: "requestStagedDiff" }>

function scene() {
  const handlers = new Set<(message: ExtensionMessage) => void>()
  const posted: Posted[] = []
  const vscode = {
    postMessage: (message: WebviewMessage) => {
      if (message.type === "requestStagedDiff") posted.push(message)
    },
    onMessage: (handler: (message: ExtensionMessage) => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
  const send = (message: ExtensionMessage) => {
    for (const handler of handlers) handler(message)
  }
  return { vscode, posted, send }
}

function mounted(run: () => ReturnType<typeof useStagedDiff>) {
  let dispose = () => {}
  let value!: ReturnType<typeof useStagedDiff>
  createRoot((d) => {
    dispose = d
    value = run()
  })
  return { value, dispose }
}

describe("useStagedDiff", () => {
  it("maps host replies to the written path and the empty result", async () => {
    const { vscode, posted, send } = scene()
    const { value: staged, dispose } = mounted(() => useStagedDiff(vscode))

    const first = staged.write("s1")
    expect(posted).toEqual([{ type: "requestStagedDiff", requestId: "staged-diff-1", sessionID: "s1" }])
    send({ type: "stagedDiffResult", requestId: "staged-diff-1", path: "staged_diff_output.txt" })
    await expect(first).resolves.toEqual({ path: "staged_diff_output.txt" })

    const second = staged.write()
    expect(posted.at(-1)).toMatchObject({ type: "requestStagedDiff", requestId: "staged-diff-2" })
    expect(posted.at(-1)?.sessionID).toBeUndefined()
    send({ type: "stagedDiffResult", requestId: "staged-diff-2", empty: true })
    await expect(second).resolves.toEqual({ empty: true })

    expect(staged.pending()).toBe(false)
    dispose()
  })

  it("rejects on host errors and on cleanup", async () => {
    const { vscode, send } = scene()
    const { value: staged, dispose } = mounted(() => useStagedDiff(vscode))

    const failed = staged.write()
    send({ type: "stagedDiffError", requestId: "staged-diff-1", error: "boom" })
    await expect(failed).rejects.toThrow("boom")

    const cancelled = staged.write()
    expect(staged.pending()).toBe(true)
    dispose()
    await expect(cancelled).rejects.toThrow("Staged diff request cancelled")
    expect(staged.pending()).toBe(false)
  })
})
