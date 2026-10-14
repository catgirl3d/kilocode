import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { Memento } from "vscode"
import {
  handleSessionFavoritesMessage,
  initSessionFavorites,
  onSessionFavoritesChanged,
  removeSessionFavorites,
  sessionFavorites,
} from "../../src/session-favorites"

type State = { sessions: string[] }

function memory(seed?: unknown) {
  const data = new Map<string, unknown>()
  if (seed !== undefined) data.set("sessionFavorites", seed)
  let writes = 0
  let fail = false
  return {
    data,
    writes: () => writes,
    fail: () => (fail = true),
    state: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        writes++
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

async function act(action: unknown, out: unknown[] = [], requestID = "request") {
  await handleSessionFavoritesMessage({ type: "sessionFavoriteAction", requestID, action }, (message) =>
    out.push(message),
  )
  return out.at(-1)
}

describe("session favorites store", () => {
  let saved: ReturnType<typeof memory>

  beforeEach(() => {
    saved = memory()
    initSessionFavorites(saved.state)
  })

  it("sets and unsets favorites in stable order without writing no-ops", async () => {
    await act({ type: "set", sessionID: "ses-a", favorite: true })
    await act({ type: "set", sessionID: "ses-b", favorite: true })
    expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b"] })
    expect(saved.writes()).toBe(2)

    await act({ type: "set", sessionID: "ses-a", favorite: true })
    await act({ type: "set", sessionID: "ses-missing", favorite: false })
    expect(saved.writes()).toBe(2)

    await act({ type: "set", sessionID: "ses-a", favorite: false })
    expect(sessionFavorites()).toEqual({ sessions: ["ses-b"] })
    expect(saved.writes()).toBe(3)
  })

  it("reloads sanitized entries without persisting the repaired snapshot", () => {
    const seed = {
      sessions: ["ses-a", "", "cloud:ses-b", "ses-a", "ses-c", 7, null],
    }
    saved = memory(seed)

    initSessionFavorites(saved.state)

    expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-c"] })
    expect(saved.writes()).toBe(0)
    expect(saved.data.get("sessionFavorites")).toEqual(seed)
  })

  it("rejects invalid actions and empty request IDs without writing", async () => {
    expect(await act(null)).toMatchObject({ type: "sessionFavoriteResult", ok: false, error: "invalid" })
    expect(await act({ type: "set", sessionID: "ses-a", favorite: "yes" })).toMatchObject({
      ok: false,
      error: "invalid",
    })
    for (const sessionID of ["", "cloud:ses-b"]) {
      expect(await act({ type: "set", sessionID, favorite: true })).toMatchObject({
        ok: false,
        error: "invalid",
      })
    }

    const out: unknown[] = []
    await handleSessionFavoritesMessage(
      { type: "sessionFavoriteAction", requestID: "", action: { type: "set", sessionID: "ses-a", favorite: true } },
      (message) => out.push(message),
    )

    expect(out).toEqual([])
    expect(saved.writes()).toBe(0)
    expect(sessionFavorites()).toEqual({ sessions: [] })
  })

  it("keeps the old state after a failed write and accepts the next operation", async () => {
    await act({ type: "set", sessionID: "ses-a", favorite: true })
    const before = sessionFavorites()
    const out: unknown[] = []
    const seen: State[] = []
    const off = onSessionFavoritesChanged((value) => seen.push(value))
    const error = spyOn(console, "error").mockImplementation(() => {})
    saved.fail()

    try {
      await act({ type: "set", sessionID: "ses-b", favorite: true }, out, "failed")
      expect(out).toEqual([{ type: "sessionFavoriteResult", requestID: "failed", ok: false, error: "storage" }])
      expect(sessionFavorites()).toEqual(before)
      expect(saved.data.get("sessionFavorites")).toEqual(before)
      expect(seen).toEqual([])

      await act({ type: "set", sessionID: "ses-b", favorite: true }, out, "next")
      expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-b"] })
      expect(out.at(-1)).toEqual({ type: "sessionFavoriteResult", requestID: "next", ok: true })
      expect(seen).toEqual([{ sessions: ["ses-a", "ses-b"] }])
      expect(error).toHaveBeenCalled()
    } finally {
      off()
      error.mockRestore()
    }
  })

  it("serializes concurrent actions against the latest state", async () => {
    await Promise.all([
      act({ type: "set", sessionID: "ses-a", favorite: true }, [], "a"),
      act({ type: "set", sessionID: "ses-b", favorite: true }, [], "b"),
      act({ type: "set", sessionID: "ses-c", favorite: true }, [], "c"),
      act({ type: "set", sessionID: "ses-b", favorite: false }, [], "d"),
    ])

    expect(sessionFavorites()).toEqual({ sessions: ["ses-a", "ses-c"] })
    expect(saved.data.get("sessionFavorites")).toEqual({ sessions: ["ses-a", "ses-c"] })
  })

  it("cleans up deleted sessions, contains cleanup failures, and keeps cleanup idempotent", async () => {
    await act({ type: "set", sessionID: "ses-a", favorite: true })
    await act({ type: "set", sessionID: "ses-b", favorite: true })
    const writes = saved.writes()

    await removeSessionFavorites("ses-a")
    await removeSessionFavorites("ses-a")
    expect(sessionFavorites()).toEqual({ sessions: ["ses-b"] })
    expect(saved.writes()).toBe(writes + 1)

    const error = spyOn(console, "error").mockImplementation(() => {})
    saved.fail()
    try {
      await expect(removeSessionFavorites("ses-b")).resolves.toBeUndefined()
      expect(sessionFavorites()).toEqual({ sessions: ["ses-b"] })
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }

    await act({ type: "set", sessionID: "ses-c", favorite: true })
    expect(sessionFavorites()).toEqual({ sessions: ["ses-b", "ses-c"] })
  })

  it("isolates listeners and reply delivery failures from saved changes", async () => {
    const seen: State[] = []
    const offA = onSessionFavoritesChanged(() => {
      throw new Error("listener failed")
    })
    const offB = onSessionFavoritesChanged((state) => seen.push(state))
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      await expect(
        handleSessionFavoritesMessage(
          {
            type: "sessionFavoriteAction",
            requestID: "reply-fails",
            action: { type: "set", sessionID: "ses-a", favorite: true },
          },
          () => {
            throw new Error("delivery failed")
          },
        ),
      ).resolves.toBe(true)

      expect(sessionFavorites()).toEqual({ sessions: ["ses-a"] })
      expect(seen).toEqual([{ sessions: ["ses-a"] }])
      expect(error).toHaveBeenCalled()
    } finally {
      offA()
      offB()
      error.mockRestore()
    }
  })

  it("returns an independent snapshot for request messages", async () => {
    await act({ type: "set", sessionID: "ses-a", favorite: true })
    const out: unknown[] = []

    await handleSessionFavoritesMessage({ type: "requestSessionFavorites" }, (message) => out.push(message))

    expect(out).toEqual([{ type: "sessionFavoritesLoaded", state: { sessions: ["ses-a"] } }])
    const message = out[0] as { state: State }
    message.state.sessions.push("ses-mutated")
    expect(sessionFavorites()).toEqual({ sessions: ["ses-a"] })
  })
})
