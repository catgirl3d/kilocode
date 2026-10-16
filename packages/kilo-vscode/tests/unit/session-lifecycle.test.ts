import { describe, expect, test } from "bun:test"
import type { Memento } from "vscode"
import { handleSessionLifecycle } from "../../src/agent-manager/session-lifecycle"
import type { ProjectContexts } from "../../src/agent-manager/project/contexts"
import type { AgentManagerOutMessage } from "../../src/agent-manager/types"
import type { Session } from "@kilocode/sdk/v2/client"
import { initSessionColors, sessionColors, setSessionColor } from "../../src/session-colors"

const info: Session = {
  id: "session",
  slug: "test-session",
  projectID: "project",
  directory: "/repo",
  title: "Browser session",
  version: "1",
  time: { created: 1, updated: 2 },
}

describe("session lifecycle merge integration", () => {
  test.each(["sessionID", "info"])("preserves deletion guards and browser cleanup for %s events", (shape) => {
    const sessions: Array<{ id: string }> = []
    const closed: string[] = []
    const persisted: string[] = []
    const pushed: unknown[] = []
    const posted: AgentManagerOutMessage[] = []
    const state = {
      getSession: () => undefined,
      getWorktrees: () => [],
      removeSession: (id: string) => persisted.push(id),
    }
    const context = {
      id: "project",
      lifecycle: "ready",
      peekState: () => state,
      sessions: () => sessions,
      upsertSession: (session: { id: string }) => sessions.push(session),
      removeLiveSession: (id: string) =>
        sessions.splice(
          sessions.findIndex((session) => session.id === id),
          1,
        ),
      invalidateSessions: () => {},
    }
    const deps = {
      busy: new Set([info.id]),
      removed: new Set<string>(),
      contexts: {
        byDirectory: () => context,
        byLiveSession: () => context,
      } as unknown as ProjectContexts,
      closeBrowser: (id: string) => closed.push(id),
      post: (message: AgentManagerOutMessage) => posted.push(message),
      push: (ctx: unknown) => pushed.push(ctx),
    }
    handleSessionLifecycle({ type: "session.created", properties: { info } }, deps)
    expect(sessions).toHaveLength(1)
    handleSessionLifecycle(
      { type: "session.deleted", properties: shape === "info" ? { info } : { sessionID: info.id } },
      deps,
    )
    expect(closed).toEqual([info.id])
    expect(deps.removed.has(info.id)).toBe(true)
    expect(deps.busy.has(info.id)).toBe(false)
    expect(sessions).toHaveLength(0)
    expect(persisted).toEqual([info.id])
    expect(pushed).toEqual([context])
    const count = posted.length
    handleSessionLifecycle({ type: "session.updated", properties: { info } }, deps)
    expect(sessions).toHaveLength(0)
    expect(posted).toHaveLength(count)
    handleSessionLifecycle({ type: "session.created", properties: { info } }, deps)
    expect(deps.removed.has(info.id)).toBe(false)
    expect(sessions).toHaveLength(1)
  })

  test("removes the persisted session color when the backend deletes the session", async () => {
    const data = new Map<string, unknown>()
    initSessionColors({
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        data.set(key, value)
      },
      keys: () => [...data.keys()],
      setKeysForSync: () => {},
    } as unknown as Memento)
    await setSessionColor(info.id, "Red")

    const deps = {
      busy: new Set<string>(),
      removed: new Set<string>(),
      contexts: { byDirectory: () => undefined, byLiveSession: () => undefined } as unknown as ProjectContexts,
      closeBrowser: () => {},
      post: () => {},
      push: () => {},
    }
    handleSessionLifecycle({ type: "session.deleted", properties: { sessionID: info.id } }, deps)
    await Bun.sleep(0)

    expect(sessionColors()).toEqual({})
  })
})
