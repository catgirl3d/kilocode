import { describe, it, expect, spyOn } from "bun:test"
import * as vscode from "vscode"
import type { Memento } from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { ProjectRouteService } from "../../src/agent-manager/project/route"
import { initSessionFavorites, sessionFavorites } from "../../src/session-favorites"
import { handleSessionTagsMessage, initSessionTags, sessionTags } from "../../src/session-tags"
import type { DiffViewerProvider } from "../../src/diff/DiffViewerProvider"
import type { PRReviewCommentData } from "../../src/shared/review-comments"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type SessionGetParams = { sessionID: string; directory: string }

// getSessionGitDirectory returns forward-slashed paths on every platform.
const posix = (value: string) => value.replaceAll("\\", "/")

/**
 * Minimal connection service mock: exposes a controllable client whose
 * session.get records every call so tests can assert which directory was
 * queried. Mirrors the shape used by kilo-provider-session-refresh.test.ts.
 */
function mockConnection(getImpl?: (p: SessionGetParams) => Promise<unknown>, vcs = "git") {
  const calls: SessionGetParams[] = []
  const projectCalls: string[] = []
  const client = {
    session: {
      get: async (p: SessionGetParams) => {
        calls.push(p)
        if (getImpl) return getImpl(p)
        return {
          data: {
            id: p.sessionID,
            slug: p.sessionID,
            projectID: "prj-test",
            directory: p.directory,
            title: "s",
            version: "1",
            time: { created: 1, updated: 1 },
          },
        }
      },
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      shake: async (_p: { sessionID: string; directory: string }) => ({
        data: { parts: 0, tokens: 0, diagnostics: {} },
      }),
      command: async (_p: unknown) => ({ data: {} }),
    },
    experimental: {
      session: {
        list: async (_p: unknown) => ({ data: [], response: { headers: new Headers() } }),
      },
    },
    project: {
      current: async (p: { directory: string }) => {
        projectCalls.push(p.directory)
        return { data: { vcs } }
      },
    },
    provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
    app: {
      agents: async () => ({ data: [] }),
      skills: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    indexing: { status: async () => ({ data: { state: "disabled" } }) },
    kilo: {
      notifications: async () => ({ data: [] }),
      profile: async () => ({ data: {} }),
    },
  }
  let current: typeof client | null = client
  return {
    calls,
    projectCalls,
    connection: {
      connect: async () => {
        current = client
      },
      getClient: () => {
        if (!current) throw new Error("Not connected")
        return current
      },
      getClientAsync: async () => client,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onNotificationDismissed: () => () => undefined,
      onSessionAcknowledged: () => () => undefined,
      clearPermissionSession: () => undefined,
      pruneSession: () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      onClearPendingPrompts: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      registerVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterVisible: () => undefined,
      unregisterAttached: () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      prepareTools: async () => {},
      notifyNotificationDismissed: () => undefined,
    } as unknown as ConstructorParameters<typeof KiloProvider>[1],
  }
}

async function withNestedRepo(run: (root: string) => Promise<void>): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-nested-repo-"))
  const root = path.join(base, "frontend")
  await fs.mkdir(root)
  const result = Bun.spawnSync({ cmd: ["git", "init"], cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
  try {
    await run(root)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
}

type ProviderInternals = {
  client: unknown
  projectID: string | undefined
  tagProjectSent: string | undefined
  connectionState: "connecting" | "connected" | "disconnected" | "error"
  initConnectionPromise: Promise<void> | null
  isWebviewReady: boolean
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  pendingSessionRefresh: boolean
  startStatsPolling: () => void
  contextSessionID: string | undefined
  handleLoadSessions: (more?: boolean) => Promise<void>
  flushPendingSessionRefresh: (reason: string) => Promise<void>
  _getHtmlForWebview: (webview: vscode.Webview, sidebar?: boolean) => string
  resolveWebviewPanel: (panel: vscode.WebviewPanel) => void
  resolveSession: (sessionID?: string, draftID?: string, context?: string, directory?: string) => Promise<unknown>
  handleCreateSession: () => Promise<void>
  checkpoints: Map<string, Promise<void>>
  sessionStatusMap: Map<string, string>
  retryAbortControllers: Map<string, AbortController>
  openChanges: (sessionID?: string, turnID?: string, comment?: PRReviewCommentData) => Promise<void>
  refreshGitStatus: (directory?: string, sessionID?: string) => Promise<void>
  refreshGitStatusFromParts: (parts: unknown[], sessionID?: string) => Promise<boolean>
  refreshSessionDetails: (sessionID: string, dir: string) => void
  handleSendCommand: (
    command: string,
    args: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
    variant?: string,
    files?: unknown[],
    context?: string,
    contextDirectory?: string,
  ) => Promise<void>
  handleShake: (sessionID?: string) => Promise<void>
}

/**
 * Short-circuit initializeConnection: setting initConnectionPromise to a
 * resolved promise makes the guarded initializeConnection() return
 * immediately, and connectionState="connected" satisfies the guards in
 * getSessionInfo. This avoids the full backend init sequence (commands,
 * indexing, git status) which the minimal mock does not implement.
 */
function connect(internal: ProviderInternals): void {
  internal.connectionState = "connected"
  internal.initConnectionPromise = Promise.resolve()
}

describe("KiloProvider route integration", () => {
  const session = {
    id: "ses-background",
    slug: "background",
    projectID: "backend-b",
    directory: "/repo/b",
    title: "Background session",
    version: "1",
    time: { created: 1, updated: 1 },
  }

  it("registers a background source without replacing the foreground session", () => {
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo/a",
      projectQualifier: () => ({ projectId: "a" }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    internal.webview = { postMessage: async (message) => posted.push(message) }
    internal.isWebviewReady = true
    internal.contextSessionID = "foreground"
    provider.registerSession(session, false, "b")
    expect(internal.contextSessionID).toBe("foreground")
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "sessionCreated",
        projectId: "b",
        session: expect.objectContaining({ id: session.id }),
      }),
    )
  })

  it.each(["draft", "explicit"])("retains the source of a delayed %s local creation", async (mode) => {
    const { connection } = mockConnection()
    const started = Promise.withResolvers<void>()
    const created = Promise.withResolvers<{ data: typeof session }>()
    const client = connection.getClient()
    Object.assign(client.session, {
      create: () => {
        started.resolve()
        return created.promise
      },
    })
    let project = "b"
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => `/repo/${project}`,
      projectQualifier: () => ({ projectId: project }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.webview = { postMessage: async (message) => posted.push(message) }
    internal.isWebviewReady = true
    const pending =
      mode === "draft"
        ? internal.resolveSession(undefined, "pending-b", "local", "/repo/b")
        : internal.handleCreateSession()
    await started.promise
    project = "a"
    internal.contextSessionID = "foreground"
    created.resolve({ data: session })
    await pending
    expect(internal.contextSessionID).toBe("foreground")
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "sessionCreated",
        projectId: "b",
        session: expect.objectContaining({ id: session.id }),
      }),
    )
  })

  const comment: PRReviewCommentData = {
    id: "thread-one",
    origin: "pr",
    author: "reviewer",
    body: "Keep the selection while loading.",
    file: "src/selection.ts",
    line: 4,
  }

  it("opens PR comments beside a chat tab and sends them back to the originating session", async () => {
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/active/root",
      topBarSurface: "tab",
    })
    provider.setSessionDirectory("origin", "/repo/origin")
    const opened: NonNullable<Parameters<DiffViewerProvider["openFromCommand"]>[0]>[] = []
    provider.setDiffViewerProvider({ openFromCommand: (args) => opened.push(args) } as DiffViewerProvider)
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    internal.webview = { postMessage: async (message) => posted.push(message) }
    internal.isWebviewReady = true
    provider.setReviewCommentsHandler(() => {
      throw new Error("A live origin must not use the fallback")
    })

    await internal.openChanges("origin", undefined, comment)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ sessionId: "origin", directory: "/repo/origin", beside: true, comment })
    internal.contextSessionID = "another-session"
    opened[0]!.onComments?.([comment], true)
    expect(posted).toContainEqual({
      type: "appendReviewComments",
      comments: [comment],
      autoSend: true,
      sessionID: "origin",
    })
  })

  it.each([
    ["origin", "origin", true],
    ["sidebar-pending:draft", undefined, false],
    ["pending:draft", undefined, false],
  ] as const)(
    "keeps PR comment delivery alive after the originating provider is disposed (%s)",
    async (id, target, send) => {
      const { connection } = mockConnection()
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => "/active/root",
      })
      provider.setSessionDirectory(id, "/repo/origin")
      const opened: NonNullable<Parameters<DiffViewerProvider["openFromCommand"]>[0]>[] = []
      const received: unknown[] = []
      provider.setDiffViewerProvider({ openFromCommand: (args) => opened.push(args) } as DiffViewerProvider)
      const stable = (comments: unknown[], autoSend: boolean, sessionID?: string, directory?: string) =>
        received.push({ comments, autoSend, sessionID, directory })
      provider.setReviewCommentsHandler(stable)

      const internal = provider as unknown as ProviderInternals
      await internal.openChanges(id, undefined, comment)
      provider.dispose()
      expect(provider.canReceiveReviewComments()).toBe(false)
      opened[0]!.onComments?.([comment], true)

      expect(received).toEqual([{ comments: [comment], autoSend: send, sessionID: target, directory: "/repo/origin" }])
    },
  )

  it("does not open a PR comment in an unrelated project for an ambiguous session", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerProject("b", "/repo/b", 1)
    routes.registerSession({ projectId: "a", sessionId: "same" }, "/repo/a", 1)
    routes.registerSession({ projectId: "b", sessionId: "same" }, "/repo/b", 1)
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const opened: unknown[] = []
    provider.setDiffViewerProvider({ openFromCommand: (args) => opened.push(args) } as DiffViewerProvider)
    const internal = provider as unknown as ProviderInternals
    await internal.openChanges("same", undefined, comment)
    expect(opened).toEqual([])
  })

  it("finds a nested Git root when the workspace parent is not a repo", async () => {
    await withNestedRepo(async (root) => {
      const source = path.join(root, "src")
      await fs.mkdir(source)
      const { connection, projectCalls } = mockConnection(undefined, "none")
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => source,
      })
      const internal = provider as unknown as ProviderInternals
      const sent: unknown[] = []
      internal.connectionState = "connected"
      internal.initConnectionPromise = Promise.resolve()
      internal.isWebviewReady = true
      internal.startStatsPolling = () => {}
      internal.webview = { postMessage: async (message) => sent.push(message) }

      await internal.refreshGitStatus(source)

      expect(projectCalls).toEqual([source])
      expect(sent).toContainEqual({ type: "gitStatus", repo: true })
    })
  })

  it("keeps a session's discovered Git root across focus refreshes", async () => {
    await withNestedRepo(async (root) => {
      const source = path.join(root, "src")
      await fs.mkdir(source)
      const parent = path.dirname(root)
      const { connection } = mockConnection(undefined, "none")
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => parent,
      })
      const internal = provider as unknown as ProviderInternals
      internal.connectionState = "connected"
      internal.initConnectionPromise = Promise.resolve()
      internal.isWebviewReady = true
      internal.startStatsPolling = () => {}
      internal.webview = { postMessage: async () => true }

      await internal.refreshGitStatus(source, "s1")
      const resolved = posix(await fs.realpath(root))
      expect(provider.getSessionGitDirectory("s1")).toBe(resolved)

      const calls: Array<{ directory?: string; sessionID?: string }> = []
      internal.refreshGitStatus = async (directory, sessionID) => {
        calls.push({ directory, sessionID })
      }
      internal.contextSessionID = "s1"
      internal.refreshSessionDetails("s1", parent)

      expect(calls).toEqual([{ directory: resolved, sessionID: "s1" }])
    })
  })

  it("keeps the session on its owning repo after tools touch a nested repo", async () => {
    await withNestedRepo(async (root) => {
      const nested = path.join(root, "vendor", "lib")
      await fs.mkdir(nested, { recursive: true })
      const result = Bun.spawnSync({ cmd: ["git", "init"], cwd: nested, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())

      const { connection } = mockConnection(undefined, "none")
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => root,
      })
      const internal = provider as unknown as ProviderInternals
      internal.contextSessionID = "s1"
      internal.startStatsPolling = () => {}

      expect(
        await internal.refreshGitStatusFromParts(
          [
            {
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { filePath: path.join(nested, "readme.md") } },
            },
          ],
          "s1",
        ),
      ).toBe(false)
      expect(provider.getSessionGitDirectory("s1")).toBeUndefined()

      await internal.refreshGitStatusFromParts(
        [
          {
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              metadata: { filediff: { file: path.join(nested, "src.ts") } },
            },
          },
        ],
        "s1",
      )

      expect(provider.getSessionGitDirectory("s1")).toBe(posix(await fs.realpath(root)))
    })
  })

  it("caches an inactive child repo without changing the visible Git status", async () => {
    await withNestedRepo(async (root) => {
      const { connection } = mockConnection(undefined, "none")
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => path.dirname(root),
      })
      const internal = provider as unknown as ProviderInternals
      const sent: unknown[] = []
      internal.contextSessionID = "parent"
      internal.isWebviewReady = true
      internal.webview = { postMessage: async (message) => sent.push(message) }

      await internal.refreshGitStatus(root, "child")

      expect(provider.getSessionGitDirectory("child")).toBe(posix(await fs.realpath(root)))
      expect(sent).not.toContainEqual({ type: "gitStatus", repo: true })
    })
  })

  it("does no Git work for non-mutating part updates", async () => {
    await withNestedRepo(async (root) => {
      const { connection, projectCalls } = mockConnection(undefined, "none")
      const provider = new KiloProvider({} as never, connection, undefined, {
        rootDirectory: () => root,
      })
      const internal = provider as unknown as ProviderInternals
      const parts = [
        { type: "text", text: "chunk" },
        { type: "reasoning", text: "thought" },
        { type: "step-start" },
        { type: "step-finish" },
        { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "README.md" } } },
        { type: "tool", tool: "bash", state: { status: "running" } },
        { type: "tool", tool: "grep", state: { status: "completed" } },
      ]

      for (const part of parts) {
        expect(await internal.refreshGitStatusFromParts([part], "s1")).toBe(false)
      }

      expect(projectCalls).toEqual([])
      expect(provider.getSessionGitDirectory("s1")).toBeUndefined()
    })
  })

  it("checks Git capability in the active project directory", async () => {
    const { connection, projectCalls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/workspace/parent/project-b",
      projectQualifier: () => ({ projectId: "project-b" }),
    })
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []
    internal.connectionState = "connected"
    internal.initConnectionPromise = Promise.resolve()
    internal.isWebviewReady = true
    internal.startStatsPolling = () => {}
    internal.webview = { postMessage: async (message) => sent.push(message) }

    await internal.refreshGitStatus()

    expect(projectCalls).toEqual(["/workspace/parent/project-b"])
    expect(sent).toContainEqual({ type: "gitStatus", repo: true })
  })

  it("resolves a unique Local session route to its exact project root", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerSession({ projectId: "a", sessionId: "ses-local" }, "/repo/a", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const internal = provider as unknown as ProviderInternals
    // Pretend the backend is already connected so getSessionInfo does not
    // run the full initialization sequence.
    connect(internal)

    await provider.getSessionInfo("ses-local")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.directory).toBe("/repo/a")
    expect(calls[0]!.sessionID).toBe("ses-local")
  })

  it("resolves a unique worktree session route to its exact worktree directory", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerWorktree({ projectId: "a", worktreeId: "wt" }, "/repo/a/.kilo/wt", 1)
    routes.registerSession({ projectId: "a", sessionId: "ses-wt" }, "/repo/a/.kilo/wt", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)

    await provider.getSessionInfo("ses-wt")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.directory).toBe("/repo/a/.kilo/wt")
  })

  it("does NOT query the active root for an ambiguous raw session id", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerProject("b", "/repo/b", 1)
    // Same raw session id registered in two projects — ambiguous.
    routes.registerSession({ projectId: "a", sessionId: "same" }, "/repo/a", 1)
    routes.registerSession({ projectId: "b", sessionId: "same" }, "/repo/b", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)

    const result = await provider.getSessionInfo("same")

    // Must not hit the backend at all — no active-root fallback.
    expect(calls).toHaveLength(0)
    expect(result).toBeUndefined()
  })

  it("does NOT silently use a stale sessionDirectories entry for an ambiguous id", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerProject("b", "/repo/b", 1)
    routes.registerSession({ projectId: "a", sessionId: "same" }, "/repo/a", 1)
    routes.registerSession({ projectId: "b", sessionId: "same" }, "/repo/b", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    // Simulate the legacy single-entry map holding only one project's dir.
    provider.setSessionDirectory("same", "/repo/a")
    const internal = provider as unknown as ProviderInternals
    connect(internal)

    await provider.getSessionInfo("same")

    // The route service blocks the query despite sessionDirectories having
    // an entry, because the id is ambiguous and no qualifier disambiguates.
    expect(calls).toHaveLength(0)
  })

  it("resolves an ambiguous id through a project qualifier to the exact dir", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerProject("b", "/repo/b", 1)
    routes.registerSession({ projectId: "a", sessionId: "same" }, "/repo/a", 1)
    routes.registerSession({ projectId: "b", sessionId: "same" }, "/repo/b", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
      projectQualifier: () => ({ projectId: "b" }),
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)

    await provider.getSessionInfo("same")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.directory).toBe("/repo/b")
  })

  it("falls back to sessionDirectories when no route service is configured (non-Agent-Manager)", async () => {
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/active/root",
    })
    provider.setSessionDirectory("ses-plain", "/some/dir")
    const internal = provider as unknown as ProviderInternals
    connect(internal)

    await provider.getSessionInfo("ses-plain")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.directory).toBe("/some/dir")
  })

  it("exposes route registration helpers that forward to the route service", () => {
    const routes = new ProjectRouteService()
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })

    provider.registerProjectRoute({ projectId: "a" }, "/repo/a", 1)
    provider.registerWorktreeRoute({ projectId: "a", worktreeId: "wt" }, "/repo/a/.kilo/wt", 1)
    provider.registerSessionRoute({ projectId: "a", sessionId: "s" }, "/repo/a/.kilo/wt", 1)

    expect(provider.isSessionRouteAmbiguous("s")).toBe(false)
    expect(provider.routeSessionDirectoryFor({ projectId: "a", sessionId: "s" })).toBe("/repo/a/.kilo/wt")

    provider.unregisterSessionRoute({ projectId: "a", sessionId: "s" })
    expect(provider.routeSessionDirectoryFor({ projectId: "a", sessionId: "s" })).toBeUndefined()
  })

  it("refuses to run a share command on an ambiguous raw session id (no active-root fallback)", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerProject("b", "/repo/b", 1)
    routes.registerSession({ projectId: "a", sessionId: "same" }, "/repo/a", 1)
    routes.registerSession({ projectId: "b", sessionId: "same" }, "/repo/b", 1)
    const { connection, calls } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)
    const posted: unknown[] = []
    internal.webview = { postMessage: async (m) => posted.push(m) }

    // share/unshare are commands routed through handleSendCommand → resolveSession.
    await internal.handleSendCommand("share", "", "mid", "same")

    // No backend session.command call should fire — the ambiguous id is
    // refused before any directory is resolved.
    expect(calls).toHaveLength(0)
    const failed = posted.find(
      (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "sendMessageFailed",
    )
    expect(failed, "expected a sendMessageFailed message for the ambiguous share command").toBeTruthy()
  })

  function goal(error?: string) {
    const { connection } = mockConnection()
    const calls: unknown[] = []
    const sent: unknown[] = []
    const client = connection.getClient()
    client.session.command = async (input) => {
      calls.push(input)
      return (
        error
          ? { error, response: new Response(null, { status: 409 }) }
          : {
              data: {
                parts: [
                  { type: "text", text: "Goal paused" },
                  { type: "reasoning", text: "hidden" },
                ],
              },
            }
      ) as Awaited<ReturnType<typeof client.session.command>>
    }
    const internal = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/goal/worktree",
    }) as unknown as ProviderInternals
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => sent.push(message) }
    return { internal, calls, sent }
  }

  it.each([
    { args: "Fix failing tests", control: false },
    { args: "resume", control: false },
    { args: "", control: true },
    { args: "pause", control: true },
    { args: "clear", control: true },
  ])(
    "waits for checkpoints before starting or resuming goals but sends controls immediately: %j",
    async ({ args, control }) => {
      const { internal, calls, sent } = goal()
      const pending = Promise.withResolvers<void>()
      const retry = new AbortController()
      internal.checkpoints.set("goal-session", pending.promise)
      internal.retryAbortControllers.set("goal-session", retry)
      internal.sessionStatusMap.set("goal-session", "busy")
      const notice = spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
      try {
        const send = internal.handleSendCommand(
          "goal",
          args,
          "goal-message",
          "goal-session",
          undefined,
          "test",
          "selected",
          "ask",
          "high",
        )
        await Promise.resolve()
        await Promise.resolve()
        expect(calls).toHaveLength(control ? 1 : 0)
        if (!control) {
          expect(sent).not.toContainEqual({ type: "sessionCommandCompleted", messageID: "goal-message" })
          pending.resolve()
        }
        await send
        expect(calls).toHaveLength(1)
        expect(calls.at(0)).toMatchObject({
          sessionID: "goal-session",
          directory: "/goal/worktree",
          command: "goal",
          arguments: args,
          model: control ? undefined : "test/selected",
          agent: control ? undefined : "ask",
          variant: control ? undefined : "high",
        })
        expect(sent).toContainEqual({ type: "sessionCommandCompleted", messageID: "goal-message" })
        expect(sent).not.toContainEqual(expect.objectContaining({ type: "sessionStatus" }))
        expect(internal.sessionStatusMap.get("goal-session")).toBe("busy")
        expect(internal.retryAbortControllers.get("goal-session")).toBe(retry)
        expect(notice.mock.calls).toEqual(args ? [] : [["Goal paused"]])
      } finally {
        pending.resolve()
        notice.mockRestore()
      }
    },
  )

  it("does not resume a goal when the pending checkpoint fails", async () => {
    const { internal, calls, sent } = goal()
    const pending = Promise.withResolvers<void>()
    internal.checkpoints.set("goal-session", pending.promise)
    const send = internal.handleSendCommand("goal", "resume", "goal-message", "goal-session")
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(0)
    pending.reject(new Error("Checkpoint failed"))
    await send
    expect(calls).toHaveLength(0)
    expect(sent).toContainEqual(
      expect.objectContaining({ type: "sendMessageFailed", messageID: "goal-message", error: "Checkpoint failed" }),
    )
    expect(sent).not.toContainEqual({ type: "sessionCommandCompleted", messageID: "goal-message" })
  })

  it("reports goal command errors without marking an active run idle", async () => {
    const { internal, sent } = goal("Goal is unavailable")
    internal.sessionStatusMap.set("goal-session", "busy")
    await internal.handleSendCommand("goal", "resume", undefined, "goal-session")
    expect(sent).toContainEqual(expect.objectContaining({ type: "sendMessageFailed", error: "Goal is unavailable" }))
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "sessionStatus" }))
    expect(internal.sessionStatusMap.get("goal-session")).toBe("busy")
  })

  it("runs a share command on a unique session route against its exact directory", async () => {
    const routes = new ProjectRouteService()
    routes.registerProject("a", "/repo/a", 1)
    routes.registerWorktree({ projectId: "a", worktreeId: "wt" }, "/repo/a/.kilo/wt", 1)
    routes.registerSession({ projectId: "a", sessionId: "ses-wt" }, "/repo/a/.kilo/wt", 1)
    const { connection, calls } = mockConnection()
    // Extend the mock client with session.command to record the directory.
    const commandCalls: { sessionID: string; directory: string; command: string }[] = []
    ;(connection.getClient() as { session: { command: unknown } }).session.command = async (p: {
      sessionID: string
      directory: string
      command: string
    }) => {
      commandCalls.push(p)
      return {
        data: {
          id: p.sessionID,
          slug: p.sessionID,
          directory: p.directory,
          title: "s",
          version: "1",
          time: { created: 1, updated: 1 },
        },
      }
    }
    const provider = new KiloProvider({} as never, connection, undefined, {
      routeService: routes,
      rootDirectory: () => "/active/root",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)
    internal.webview = { postMessage: async () => undefined }

    await internal.handleSendCommand("share", "", "mid", "ses-wt")

    // session.get is called by refreshSessionDetails; the command itself
    // must target the exact worktree directory, never /active/root.
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]!.directory).toBe("/repo/a/.kilo/wt")
    expect(commandCalls[0]!.command).toBe("share")
    // No fallback to the active root anywhere.
    expect(calls.every((c) => c.directory !== "/active/root")).toBe(true)
  })

  it("forwards shake result data to the webview completion boundary", async () => {
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      session: { shake: (input: { sessionID: string; directory: string }) => Promise<unknown> }
    }
    client.session.shake = async () => ({
      data: {
        parts: 3,
        tokens: 42,
        diagnostics: {
          rawMessages: 10,
          projectionMessages: 8,
          tools: 6,
          completed: 5,
          protected: 1,
          compacted: 1,
          candidates: 4,
        },
      },
    })
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo/project",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)
    const posted: unknown[] = []
    internal.webview = { postMessage: async (message) => posted.push(message) }

    await internal.handleShake("ses-shake")

    expect(posted).toEqual([
      {
        type: "sessionShakeCompleted",
        sessionID: "ses-shake",
        parts: 3,
        tokens: 42,
        diagnostics: {
          rawMessages: 10,
          projectionMessages: 8,
          tools: 6,
          completed: 5,
          protected: 1,
          compacted: 1,
          candidates: 4,
        },
      },
    ])
  })

  it("keeps a configured shake command on the generic provider command boundary", async () => {
    const { connection } = mockConnection()
    const commandCalls: unknown[] = []
    const client = connection.getClient() as unknown as { session: { command: (input: unknown) => Promise<unknown> } }
    client.session.command = async (input) => {
      commandCalls.push(input)
      return { data: {} }
    }
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo/project",
    })
    const internal = provider as unknown as ProviderInternals
    connect(internal)
    internal.webview = { postMessage: async () => undefined }

    await internal.handleSendCommand("shake", "arg", "message-1", "ses-shake")

    expect(commandCalls).toContainEqual(
      expect.objectContaining({
        command: "shake",
        arguments: "arg",
        sessionID: "ses-shake",
        directory: "/repo/project",
      }),
    )
  })
})

function memory(seed?: unknown) {
  const data = new Map<string, unknown>()
  if (seed !== undefined) data.set("sessionTags", seed)
  let fail = false
  return {
    data,
    fail: () => {
      fail = true
    },
    state: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (fail) {
          fail = false
          throw new Error("write failed")
        }
        data.set(key, value)
      },
      keys: () => [...data.keys()],
      setKeysForSync: () => {},
    } as unknown as Memento,
  }
}

function providerRoute(provider: KiloProvider, sent: unknown[]) {
  let receive: ((message: Record<string, unknown>) => Promise<void>) | undefined
  const webview = {
    onDidReceiveMessage: (listener: (message: Record<string, unknown>) => Promise<void>) => {
      receive = listener
      return { dispose: () => {} }
    },
    postMessage: async (message: unknown) => {
      sent.push(message)
      return true
    },
  } as unknown as vscode.Webview
  const internal = provider as unknown as {
    webview: vscode.Webview | null
    setupWebviewMessageHandler: (webview: vscode.Webview) => void
  }
  internal.webview = webview
  internal.setupWebviewMessageHandler(webview)
  return async (message: Record<string, unknown>) => {
    if (!receive) throw new Error("Expected a webview message route")
    await receive(message)
  }
}

function typeList(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined
    return type === "sessionTagsLoaded" || type === "sessionTagResult" ? [type] : []
  })
}

describe("session tags", () => {
  it("uses the backend project ID returned by the session load for tag views", async () => {
    const tag = { id: "backend-tag", name: "Backend", color: "Blue" }
    initSessionTags(
      memory({
        version: 2,
        global: [],
        projects: { "backend-a": { tags: [tag], sessions: { "ses-root": [tag.id] } } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      experimental: { session: { list: (input: unknown, options?: unknown) => Promise<unknown> } }
    }
    client.experimental.session.list = async () => ({
      data: [{ id: "ses-root", projectID: "backend-a", directory: "/repo", time: { created: 1, updated: 1 } }],
      response: { headers: new Headers() },
    })
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "prj-agent-manager" }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await internal.handleLoadSessions(false)

      expect(internal.projectID).toBe("backend-a")
      expect(posted).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [tag], sessions: { "ses-root": [tag.id] } },
      })
    } finally {
      provider.dispose()
    }
  })

  it("uses a workspace directory session as the canonical project ID", async () => {
    const tag = { id: "backend-root", name: "Backend root", color: "Blue" }
    initSessionTags(
      memory({
        version: 2,
        global: [],
        projects: { "backend-root": { tags: [tag], sessions: { "ses-root": [tag.id] } } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      experimental: { session: { list: (input: { directory: string }, options?: unknown) => Promise<unknown> } }
    }
    client.experimental.session.list = async ({ directory }) => ({
      data:
        directory === "/repo"
          ? [{ id: "ses-root", projectID: "backend-root", directory, time: { created: 1, updated: 1 } }]
          : [],
      response: { headers: new Headers() },
    })
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "prj-agent-manager" }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await internal.handleLoadSessions(false)

      expect(internal.projectID).toBe("backend-root")
      expect(posted).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [tag], sessions: { "ses-root": [tag.id] } },
      })
    } finally {
      provider.dispose()
    }
  })

  it("clears the previous project tag view after a qualifier switch with an empty load", async () => {
    const local = { id: "local", name: "Local", color: "Blue" }
    const global = { id: "global", name: "Global", color: "Red", scope: "global" as const }
    initSessionTags(
      memory({
        version: 2,
        global: [global],
        projects: { "backend-a": { tags: [local], sessions: { "ses-a": [local.id] } } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      experimental: { session: { list: (input: unknown, options?: unknown) => Promise<unknown> } }
    }
    let calls = 0
    client.experimental.session.list = async () => {
      calls++
      return {
        data:
          calls === 1
            ? [{ id: "ses-a", projectID: "backend-a", directory: "/repo", time: { created: 1, updated: 1 } }]
            : [],
        response: { headers: new Headers() },
      }
    }
    let qualifier = "prj-a"
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: qualifier }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await internal.handleLoadSessions(false)
      posted.length = 0
      qualifier = "prj-b"
      await internal.handleLoadSessions(false)

      expect(internal.projectID).toBeUndefined()
      expect(posted.filter((message) => (message as { type?: string }).type === "sessionTagsLoaded")).toEqual([
        { type: "sessionTagsLoaded", state: { tags: [global], sessions: {} } },
      ])
    } finally {
      provider.dispose()
    }
  })

  it("adopts the backend project ID from the first created session", async () => {
    const tag = { id: "backend-tag", name: "Backend", color: "Blue" }
    initSessionTags(
      memory({
        version: 2,
        global: [],
        projects: { "backend-a": { tags: [tag], sessions: {} } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      session: { create: (input: unknown, options?: unknown) => Promise<unknown> }
    }
    client.session.create = async () => ({
      data: {
        id: "ses-new",
        projectID: "backend-a",
        slug: "new",
        directory: "/repo",
        title: "New",
        version: "1",
        time: { created: 1, updated: 1 },
      },
    })
    const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await internal.handleCreateSession()

      expect(internal.projectID).toBe("backend-a")
      expect(posted).toContainEqual({ type: "sessionTagsLoaded", state: { tags: [tag], sessions: {} } })
    } finally {
      provider.dispose()
    }
  })

  it("clears the tag view when a pending refresh resolves no project ID", async () => {
    const local = { id: "local", name: "Local", color: "Blue" }
    const global = { id: "global", name: "Global", color: "Red", scope: "global" as const }
    initSessionTags(
      memory({
        version: 2,
        global: [global],
        projects: { "backend-a": { tags: [local], sessions: {} } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      experimental: { session: { list: (input: unknown, options?: unknown) => Promise<unknown> } }
    }
    client.experimental.session.list = async () => ({ data: [], response: { headers: new Headers() } })
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "prj-next" }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }
    internal.projectID = "backend-a"
    internal.tagProjectSent = "backend-a"
    internal.pendingSessionRefresh = true

    try {
      await internal.flushPendingSessionRefresh("test")

      expect(internal.projectID).toBeUndefined()
      expect(posted.filter((message) => (message as { type?: string }).type === "sessionTagsLoaded")).toEqual([
        { type: "sessionTagsLoaded", state: { tags: [global], sessions: {} } },
      ])
    } finally {
      provider.dispose()
    }
  })

  it("does not repost the tag view when the resolved key is unchanged", async () => {
    initSessionTags(memory().state)
    const { connection } = mockConnection()
    const client = connection.getClient() as unknown as {
      experimental: { session: { list: (input: unknown, options?: unknown) => Promise<unknown> } }
    }
    client.experimental.session.list = async () => ({
      data: [{ id: "ses-root", projectID: "backend-a", directory: "/repo", time: { created: 1, updated: 1 } }],
      response: { headers: new Headers() },
    })
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "prj-a" }),
    })
    const internal = provider as unknown as ProviderInternals
    const posted: unknown[] = []
    connect(internal)
    internal.isWebviewReady = true
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await internal.handleLoadSessions(false)
      await internal.handleLoadSessions(false)

      expect(posted.filter((message) => (message as { type?: string }).type === "sessionTagsLoaded")).toHaveLength(1)
    } finally {
      provider.dispose()
    }
  })

  it("serves a fresh tag snapshot when another window writes before a request", async () => {
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    const saved = memory()
    initSessionTags(saved.state)
    await saved.state.update("sessionTags", {
      version: 2,
      global: [],
      projects: { repo: { tags: [ref1], sessions: {} } },
      legacy: { sessions: {} },
    })
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const internal = provider as unknown as ProviderInternals
    internal.projectID = "repo"
    const posted: unknown[] = []

    try {
      const send = providerRoute(provider, posted)
      await send({ type: "requestSessionTags" })

      expect(posted).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [ref1], sessions: {} },
      })
    } finally {
      provider.dispose()
    }
  })

  it("refreshes the webview tag snapshot when the window regains focus", async () => {
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    const saved = memory()
    initSessionTags(saved.state)
    const window = vscode.window as unknown as {
      onDidChangeWindowState: (listener: (state: { focused: boolean }) => void) => { dispose(): void }
    }
    const original = window.onDidChangeWindowState
    let listener: ((state: { focused: boolean }) => void) | undefined
    window.onDidChangeWindowState = (callback) => {
      listener = callback
      return { dispose: () => {} }
    }
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const internal = provider as unknown as ProviderInternals
    internal.projectID = "repo"
    const posted: unknown[] = []
    internal.webview = { postMessage: async (message) => posted.push(message) }

    try {
      await saved.state.update("sessionTags", {
        version: 2,
        global: [],
        projects: { repo: { tags: [ref1], sessions: {} } },
        legacy: { sessions: {} },
      })
      posted.length = 0
      listener?.({ focused: true })

      expect(posted).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [ref1], sessions: {} },
      })
    } finally {
      provider.dispose()
      window.onDidChangeWindowState = original
    }
  })

  it("refreshes the webview tag snapshot when an editor panel becomes visible", async () => {
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    const saved = memory()
    initSessionTags(saved.state)
    const posted: unknown[] = []
    const changed = Promise.withResolvers<() => void>()
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const internal = provider as unknown as ProviderInternals
    const panel = {
      active: false,
      visible: false,
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: async (message: unknown) => {
          posted.push(message)
          return true
        },
      },
      onDidChangeViewState: (listener: () => void) => {
        changed.resolve(listener)
        return { dispose: () => {} }
      },
    } as unknown as vscode.WebviewPanel
    connect(internal)
    internal.projectID = "repo"
    internal._getHtmlForWebview = () => ""

    try {
      internal.resolveWebviewPanel(panel)
      const onChange = await changed.promise
      await saved.state.update("sessionTags", {
        version: 2,
        global: [],
        projects: { repo: { tags: [ref1], sessions: {} } },
        legacy: { sessions: {} },
      })
      posted.length = 0
      panel.visible = true
      onChange()

      expect(posted).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [ref1], sessions: {} },
      })
    } finally {
      provider.dispose()
    }
  })

  it("routes without a ready CLI, broadcasts changes, and stops after provider disposal", async () => {
    initSessionTags(memory().state)
    const { connection } = mockConnection()
    connection.getClient = () => {
      throw new Error("CLI is not ready")
    }
    const first = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const second = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    ;(first as unknown as ProviderInternals).projectID = "repo"
    ;(second as unknown as ProviderInternals).projectID = "repo"
    const a: unknown[] = []
    const b: unknown[] = []
    const send = providerRoute(first, a)
    providerRoute(second, b)
    let disposed = false

    try {
      const state = first as unknown as { client: unknown; connectionState: string }
      expect(state.client).toBeNull()
      expect(state.connectionState).toBe("connecting")

      await send({ type: "requestSessionTags" })
      expect(a).toContainEqual({ type: "sessionTagsLoaded", state: { tags: [], sessions: {} } })
      expect(b).toEqual([])

      a.length = 0
      await send({
        type: "sessionTagAction",
        requestID: "create",
        action: { type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" },
      })
      expect(typeList(a)).toEqual(["sessionTagsLoaded", "sessionTagResult"])
      expect(typeList(b)).toEqual(["sessionTagsLoaded"])

      second.dispose()
      disposed = true
      const tag = sessionTags().projects.repo?.tags.at(0)
      if (!tag) throw new Error("Expected the host to save the new tag")
      await send({
        type: "sessionTagAction",
        requestID: "rename",
        action: { type: "update", id: tag.id, patch: { name: "Renamed" } },
      })
      expect(typeList(a)).toEqual(["sessionTagsLoaded", "sessionTagResult", "sessionTagsLoaded", "sessionTagResult"])
      expect(typeList(b)).toEqual(["sessionTagsLoaded"])
    } finally {
      first.dispose()
      if (!disposed) second.dispose()
    }
  })

  it("cleans assignments only after a confirmed session deletion", async () => {
    initSessionTags(memory().state)
    await handleSessionTagsMessage(
      {
        type: "sessionTagAction",
        requestID: "create",
        action: { type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" },
      },
      () => {},
      "repo",
    )
    const tag = sessionTags().projects.repo?.tags.at(0)
    if (!tag) throw new Error("Expected the host to save the new tag")
    await handleSessionTagsMessage(
      {
        type: "sessionTagAction",
        requestID: "assign",
        action: { type: "assign", sessionID: "ses-b", id: tag.id, assigned: true },
      },
      () => {},
      "repo",
    )

    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const internal = provider as unknown as {
      webview: vscode.Webview | null
      handleDeleteSession: (sessionID: string) => Promise<void>
    }
    const client = connection.getClient() as unknown as {
      backgroundProcess: { stopSession: (input: unknown) => Promise<void> }
      session: { delete: (input: unknown, options: unknown) => Promise<unknown> }
    }
    client.backgroundProcess = { stopSession: async () => {} }
    client.session.delete = async () => ({ data: {} })
    const sent: unknown[] = []
    internal.webview = {
      postMessage: async (message: unknown) => sent.push(message),
    } as unknown as vscode.Webview

    try {
      await internal.handleDeleteSession("ses-a")
      await handleSessionTagsMessage(
        {
          type: "sessionTagAction",
          requestID: "flush",
          action: { type: "assign", sessionID: "ses-b", id: tag.id, assigned: true },
        },
        () => {},
        "repo",
      )

      expect(sessionTags()).toEqual({
        version: 2,
        global: [],
        projects: { repo: { tags: [tag], sessions: { "ses-b": [tag.id] } } },
        legacy: { sessions: {} },
      })
      expect(sent).toContainEqual({ type: "sessionDeleted", sessionID: "ses-a" })
    } finally {
      provider.dispose()
    }
  })

  it("preserves assignments when the backend rejects session deletion", async () => {
    initSessionTags(memory().state)
    await handleSessionTagsMessage(
      {
        type: "sessionTagAction",
        requestID: "create",
        action: { type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" },
      },
      () => {},
      "repo",
    )
    const tag = sessionTags().projects.repo?.tags.at(0)
    if (!tag) throw new Error("Expected the host to save the new tag")

    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo",
      projectQualifier: () => ({ projectId: "repo" }),
    })
    const internal = provider as unknown as {
      webview: vscode.Webview | null
      handleDeleteSession: (sessionID: string) => Promise<void>
    }
    const client = connection.getClient() as unknown as {
      backgroundProcess: { stopSession: (input: unknown) => Promise<void> }
      session: { delete: (input: unknown, options: unknown) => Promise<unknown> }
    }
    client.backgroundProcess = { stopSession: async () => {} }
    client.session.delete = async () => {
      throw new Error("delete failed")
    }
    const sent: unknown[] = []
    internal.webview = {
      postMessage: async (message: unknown) => sent.push(message),
    } as unknown as vscode.Webview

    try {
      await internal.handleDeleteSession("ses-a")
      expect(sessionTags()).toEqual({
        version: 2,
        global: [],
        projects: { repo: { tags: [tag], sessions: { "ses-a": [tag.id] } } },
        legacy: { sessions: {} },
      })
      expect(sent).toContainEqual(expect.objectContaining({ type: "error" }))
    } finally {
      provider.dispose()
    }
  })

  it("keeps provider tag broadcasts isolated by project", async () => {
    const local = { id: "b-tag", name: "Beta", color: "Red" }
    initSessionTags(
      memory({
        version: 2,
        global: [],
        projects: { b: { tags: [local], sessions: { "ses-b": [local.id] } } },
        legacy: { sessions: {} },
      }).state,
    )
    const { connection } = mockConnection()
    connection.getClient = () => {
      throw new Error("CLI is not ready")
    }
    const first = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo/a",
      projectQualifier: () => ({ projectId: "a" }),
    })
    const second = new KiloProvider({} as never, connection, undefined, {
      rootDirectory: () => "/repo/b",
      projectQualifier: () => ({ projectId: "b" }),
    })
    ;(first as unknown as ProviderInternals).projectID = "a"
    ;(second as unknown as ProviderInternals).projectID = "b"
    const a: unknown[] = []
    const b: unknown[] = []
    const sendA = providerRoute(first, a)
    const sendB = providerRoute(second, b)

    try {
      await sendB({ type: "requestSessionTags" })
      expect(b).toContainEqual({
        type: "sessionTagsLoaded",
        state: { tags: [{ ...local }], sessions: { "ses-b": [local.id] } },
      })
      b.length = 0

      await sendA({
        type: "sessionTagAction",
        requestID: "create-a",
        action: { type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" },
      })
      const loadedA = a.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "sessionTagsLoaded",
      )
      const loadedB = b.find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "sessionTagsLoaded",
      )
      expect(loadedA).toEqual({
        type: "sessionTagsLoaded",
        state: {
          tags: [{ id: expect.any(String), name: "Alpha", color: "Blue" }],
          sessions: { "ses-a": [expect.any(String)] },
        },
      })
      expect(loadedB).toEqual({
        type: "sessionTagsLoaded",
        state: { tags: [{ ...local }], sessions: { "ses-b": [local.id] } },
      })

      b.length = 0
      await sendB({ type: "requestSessionTags" })
      expect(b).toEqual([
        { type: "sessionTagsLoaded", state: { tags: [{ ...local }], sessions: { "ses-b": [local.id] } } },
      ])
    } finally {
      first.dispose()
      second.dispose()
    }
  })
})

describe("session favorites", () => {
  it("routes offline requests and mutations, broadcasts committed state, and unsubscribes on disposal", async () => {
    const saved = memory()
    initSessionFavorites(saved.state)
    const { connection } = mockConnection()
    connection.getClient = () => {
      throw new Error("CLI is not ready")
    }
    const first = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const second = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const a: unknown[] = []
    const b: unknown[] = []
    const send = providerRoute(first, a)
    providerRoute(second, b)
    const posted = spyOn(second, "postMessage")
    let disposed = false

    try {
      const state = first as unknown as { client: unknown; connectionState: string }
      expect(state.client).toBeNull()
      expect(state.connectionState).toBe("connecting")

      await send({ type: "requestSessionFavorites" })
      expect(a).toEqual([{ type: "sessionFavoritesLoaded", state: { sessions: [] } }])
      const snapshot = a[0] as { state: { sessions: string[] } }
      snapshot.state.sessions.push("ses-mutated")
      expect(sessionFavorites()).toEqual({ sessions: [] })

      a.length = 0
      await send({
        type: "sessionFavoriteAction",
        requestID: "add",
        action: { type: "set", sessionID: "ses-a", favorite: true },
      })
      expect(sessionFavorites()).toEqual({ sessions: ["ses-a"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a"] })
      expect(a).toEqual([
        { type: "sessionFavoritesLoaded", state: { sessions: ["ses-a"] } },
        { type: "sessionFavoriteResult", requestID: "add", ok: true },
      ])
      expect(b).toEqual([{ type: "sessionFavoritesLoaded", state: { sessions: ["ses-a"] } }])

      second.dispose()
      disposed = true
      posted.mockClear()
      a.length = 0
      b.length = 0
      await send({
        type: "sessionFavoriteAction",
        requestID: "add-second",
        action: { type: "set", sessionID: "ses-b", favorite: true },
      })
      expect(a).toEqual([
        { type: "sessionFavoritesLoaded", state: { sessions: ["ses-a", "ses-b"] } },
        { type: "sessionFavoriteResult", requestID: "add-second", ok: true },
      ])
      expect(b).toEqual([])
      expect(posted).not.toHaveBeenCalled()
    } finally {
      first.dispose()
      if (!disposed) second.dispose()
      posted.mockRestore()
    }
  })

  it("preserves state and replies with a storage error when a routed write fails", async () => {
    const saved = memory()
    initSessionFavorites(saved.state)
    const { connection } = mockConnection()
    connection.getClient = () => {
      throw new Error("CLI is not ready")
    }
    const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const sent: unknown[] = []
    const send = providerRoute(provider, sent)
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      await send({
        type: "sessionFavoriteAction",
        requestID: "initial",
        action: { type: "set", sessionID: "ses-a", favorite: true },
      })
      sent.length = 0
      saved.fail()

      await send({
        type: "sessionFavoriteAction",
        requestID: "failed",
        action: { type: "set", sessionID: "ses-b", favorite: true },
      })

      expect(sessionFavorites()).toEqual({ sessions: ["ses-a"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a"] })
      expect(sent).toEqual([{ type: "sessionFavoriteResult", requestID: "failed", ok: false, error: "storage" }])
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
      provider.dispose()
    }
  })

  it("prunes only the deleted session after the backend confirms deletion", async () => {
    const saved = memory()
    initSessionFavorites(saved.state)
    initSessionTags(memory().state)
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const internal = provider as unknown as {
      webview: vscode.Webview | null
      handleDeleteSession: (sessionID: string) => Promise<void>
    }
    const client = connection.getClient() as unknown as {
      backgroundProcess: { stopSession: (input: unknown) => Promise<void> }
      session: { delete: (input: unknown, options: unknown) => Promise<unknown> }
    }
    client.backgroundProcess = { stopSession: async () => {} }
    client.session.delete = async () => ({ data: {} })
    const sent: unknown[] = []
    const send = providerRoute(provider, sent)

    try {
      await send({
        type: "sessionFavoriteAction",
        requestID: "a",
        action: { type: "set", sessionID: "ses-a", favorite: true },
      })
      await send({
        type: "sessionFavoriteAction",
        requestID: "b",
        action: { type: "set", sessionID: "ses-b", favorite: true },
      })
      sent.length = 0

      await internal.handleDeleteSession("ses-a")
      await send({
        type: "sessionFavoriteAction",
        requestID: "drain",
        // This valid no-op cannot re-add ses-b if deletion over-prunes the store.
        action: { type: "set", sessionID: "ses-never-favorited", favorite: false },
      })

      // Assert the committed state before any later mutation can mask over-pruning.
      expect(sessionFavorites()).toEqual({ sessions: ["ses-b"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-b"] })
      expect(sent).toContainEqual({ type: "sessionDeleted", sessionID: "ses-a" })
      expect(sent).toContainEqual({ type: "sessionFavoritesLoaded", state: { sessions: ["ses-b"] } })
    } finally {
      provider.dispose()
    }
  })

  it("keeps favorites and the write queue usable when successful deletion cleanup cannot persist", async () => {
    const saved = memory()
    initSessionFavorites(saved.state)
    initSessionTags(memory().state)
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const internal = provider as unknown as {
      webview: vscode.Webview | null
      handleDeleteSession: (sessionID: string) => Promise<void>
    }
    const client = connection.getClient() as unknown as {
      backgroundProcess: { stopSession: (input: unknown) => Promise<void> }
      session: { delete: (input: unknown, options: unknown) => Promise<unknown> }
    }
    client.backgroundProcess = { stopSession: async () => {} }
    client.session.delete = async () => ({ data: {} })
    const sent: unknown[] = []
    const send = providerRoute(provider, sent)
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      await send({
        type: "sessionFavoriteAction",
        requestID: "a",
        action: { type: "set", sessionID: "ses-a", favorite: true },
      })
      await send({
        type: "sessionFavoriteAction",
        requestID: "b",
        action: { type: "set", sessionID: "ses-b", favorite: true },
      })
      expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a", "ses-b"] })

      sent.length = 0
      saved.fail()
      await internal.handleDeleteSession("ses-a")
      await send({
        type: "sessionFavoriteAction",
        requestID: "drain",
        // This no-op observes failed cleanup without changing A+B.
        action: { type: "set", sessionID: "ses-never-favorited", favorite: false },
      })

      expect(sent).toContainEqual({ type: "sessionDeleted", sessionID: "ses-a" })
      expect(sent).not.toContainEqual(expect.objectContaining({ type: "sessionFavoritesLoaded" }))
      expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(error).toHaveBeenCalledWith("[Kilo New] Failed to remove session favorites:", expect.any(Error))

      sent.length = 0
      await send({
        type: "sessionFavoriteAction",
        requestID: "c",
        action: { type: "set", sessionID: "ses-c", favorite: true },
      })
      expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b", "ses-c"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a", "ses-b", "ses-c"] })
      expect(sent).toContainEqual({
        type: "sessionFavoritesLoaded",
        state: { sessions: ["ses-a", "ses-b", "ses-c"] },
      })
      expect(sent).toContainEqual({ type: "sessionFavoriteResult", requestID: "c", ok: true })
    } finally {
      error.mockRestore()
      provider.dispose()
    }
  })

  it("preserves favorites when the backend rejects a routed session deletion", async () => {
    const saved = memory()
    initSessionFavorites(saved.state)
    const { connection } = mockConnection()
    const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => "/repo" })
    const internal = provider as unknown as {
      webview: vscode.Webview | null
      handleDeleteSession: (sessionID: string) => Promise<void>
    }
    const client = connection.getClient() as unknown as {
      backgroundProcess: { stopSession: (input: unknown) => Promise<void> }
      session: { delete: (input: unknown, options: unknown) => Promise<unknown> }
    }
    client.backgroundProcess = { stopSession: async () => {} }
    client.session.delete = async () => {
      throw new Error("delete failed")
    }
    const sent: unknown[] = []
    const send = providerRoute(provider, sent)

    try {
      await send({
        type: "sessionFavoriteAction",
        requestID: "a",
        action: { type: "set", sessionID: "ses-a", favorite: true },
      })
      await send({
        type: "sessionFavoriteAction",
        requestID: "b",
        action: { type: "set", sessionID: "ses-b", favorite: true },
      })
      await send({
        type: "sessionFavoriteAction",
        requestID: "drain",
        action: { type: "set", sessionID: "ses-never-favorited", favorite: false },
      })
      sent.length = 0

      await internal.handleDeleteSession("ses-a")
      await send({
        type: "sessionFavoriteAction",
        requestID: "post-failure-drain",
        // This no-op settles any wrongly queued cleanup without repairing A+B.
        action: { type: "set", sessionID: "ses-never-favorited", favorite: false },
      })

      expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(sent).toContainEqual(expect.objectContaining({ type: "error", message: "delete failed" }))
      expect(sent).not.toContainEqual(expect.objectContaining({ type: "sessionDeleted" }))
      expect(sent).not.toContainEqual(expect.objectContaining({ type: "sessionFavoritesLoaded" }))
    } finally {
      provider.dispose()
    }
  })
})
