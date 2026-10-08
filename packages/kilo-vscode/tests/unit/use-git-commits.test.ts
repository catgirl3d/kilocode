import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

describe("useGitCommitsContext", () => {
  it("resolves concurrent commit requests into ordered source-associated attachments", async () => {
    const modulePath = "../../webview-ui/src/hooks/useGitCommitsContext"
    const feature = await import(modulePath).catch(() => undefined)
    expect(feature).toBeDefined()
    if (!feature) return

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
    let context: ReturnType<typeof feature.useGitCommitsContext>
    createRoot((cleanup) => {
      dispose = cleanup
      context = feature.useGitCommitsContext(vscode, () => true)
    })

    const first = "c".repeat(40)
    const second = "d".repeat(40)
    const text = `Compare @${first} and @${second} now.`
    try {
      const pending = context!.resolveAttachments(text, "session-3")
      expect(posted).toHaveLength(2)
      expect(posted[0]).toMatchObject({ type: "requestGitCommitContext", hash: first, sessionID: "session-3" })
      expect(posted[1]).toMatchObject({ type: "requestGitCommitContext", hash: second, sessionID: "session-3" })
      const ids = posted.map((message) => (message as { requestId: string }).requestId)

      for (const handler of handlers) {
        handler({
          type: "gitCommitContextResult",
          requestId: ids[1]!,
          hash: second,
          content: "second show",
        } as unknown as ExtensionMessage)
        handler({
          type: "gitCommitContextResult",
          requestId: ids[0]!,
          hash: first,
          content: "first show",
        } as unknown as ExtensionMessage)
      }

      const files = await pending
      expect(files.map((file) => file.filename)).toEqual([
        `git-commit-${first.slice(0, 7)}.txt`,
        `git-commit-${second.slice(0, 7)}.txt`,
      ])
      expect(files.map((file) => decodeURIComponent(file.url.split(",").at(1) ?? ""))).toEqual([
        "first show",
        "second show",
      ])
      expect(files.map((file) => file.source?.text)).toEqual([
        { value: `@${first}`, start: text.indexOf(`@${first}`), end: text.indexOf(`@${first}`) + 41 },
        { value: `@${second}`, start: text.indexOf(`@${second}`), end: text.indexOf(`@${second}`) + 41 },
      ])
    } finally {
      dispose()
    }
  })

  it("resolves repeated mentions with one request and separate attachments", async () => {
    const modulePath = "../../webview-ui/src/hooks/useGitCommitsContext"
    const feature = await import(modulePath).catch(() => undefined)
    expect(feature).toBeDefined()
    if (!feature) return

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
    let context: ReturnType<typeof feature.useGitCommitsContext>
    createRoot((cleanup) => {
      dispose = cleanup
      context = feature.useGitCommitsContext(vscode, () => true)
    })

    const hash = "f".repeat(40)
    const token = `@${hash}`
    const text = `Compare ${token} and ${token} again`
    try {
      const pending = context!.resolveAttachments(text, "session-4")
      expect(posted).toHaveLength(1)
      expect(posted.at(0)).toMatchObject({ type: "requestGitCommitContext", hash, sessionID: "session-4" })
      expect(context!.pending()).toBe(true)

      const requestId = (posted.at(0) as { requestId: string }).requestId
      for (const handler of handlers) {
        handler({
          type: "gitCommitContextResult",
          requestId,
          hash,
          content: "commit show",
        } as unknown as ExtensionMessage)
      }

      const files = await pending
      expect(files.map((file) => file.filename)).toEqual([
        `git-commit-${hash.slice(0, 7)}.txt`,
        `git-commit-${hash.slice(0, 7)}-2.txt`,
      ])
      expect(files.map((file) => file.source?.text)).toEqual(
        [text.indexOf(token), text.lastIndexOf(token)].map((start) => ({
          value: token,
          start,
          end: start + token.length,
        })),
      )
      expect(context!.pending()).toBe(false)
    } finally {
      dispose()
    }
  })

  it("rejects when the host cannot resolve a mentioned commit", async () => {
    const modulePath = "../../webview-ui/src/hooks/useGitCommitsContext"
    const feature = await import(modulePath).catch(() => undefined)
    expect(feature).toBeDefined()
    if (!feature) return

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
    let context: ReturnType<typeof feature.useGitCommitsContext>
    createRoot((cleanup) => {
      dispose = cleanup
      context = feature.useGitCommitsContext(vscode, () => true)
    })

    const pending = context!.resolveAttachments(`Review @${"e".repeat(40)}`)
    const request = posted[0] as { requestId: string }
    for (const handler of handlers) {
      handler({
        type: "gitCommitContextError",
        requestId: request.requestId,
        hash: "e".repeat(40),
        error: "Cannot read commit",
      } as unknown as ExtensionMessage)
    }

    try {
      await expect(pending).rejects.toThrow("Cannot read commit")
      expect(context!.pending()).toBe(false)
    } finally {
      dispose()
    }
  })

  it("rejects the whole resolution when one of several mentioned commits fails", async () => {
    const modulePath = "../../webview-ui/src/hooks/useGitCommitsContext"
    const feature = await import(modulePath).catch(() => undefined)
    expect(feature).toBeDefined()
    if (!feature) return

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
    let context: ReturnType<typeof feature.useGitCommitsContext>
    createRoot((cleanup) => {
      dispose = cleanup
      context = feature.useGitCommitsContext(vscode, () => true)
    })

    const first = "9".repeat(40)
    const second = "8".repeat(40)
    const pending = context!.resolveAttachments(`Compare @${first} and @${second}`)
    const ids = posted.map((message) => (message as { requestId: string }).requestId)
    for (const handler of handlers) {
      handler({
        type: "gitCommitContextResult",
        requestId: ids[0]!,
        hash: first,
        content: "ok",
      } as unknown as ExtensionMessage)
      handler({
        type: "gitCommitContextError",
        requestId: ids[1]!,
        hash: second,
        error: "unreadable",
      } as unknown as ExtensionMessage)
    }

    try {
      await expect(pending).rejects.toThrow("unreadable")
      expect(context!.pending()).toBe(false)
    } finally {
      dispose()
    }
  })
})
