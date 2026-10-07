import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { Memento } from "vscode"
import {
  handleSessionTagsMessage,
  initSessionTags,
  onSessionTagsChanged,
  removeSessionTags,
  sessionTags,
} from "../../src/session-tags"

function memory(seed?: unknown) {
  const data = new Map<string, unknown>()
  if (seed !== undefined) data.set("sessionTags", seed)
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
  await handleSessionTagsMessage({ type: "sessionTagAction", requestID, action }, (message) => out.push(message))
  return out.at(-1)
}

function firstTag() {
  const tag = sessionTags().tags.at(0)
  if (!tag) throw new Error("Expected a saved session tag")
  return tag
}

describe("session tags store", () => {
  let saved: ReturnType<typeof memory>

  beforeEach(() => {
    saved = memory()
    initSessionTags(saved.state)
  })

  it("reuses catalog tags, applies global edits, removes local assignments, and reloads", async () => {
    await act({ type: "create", sessionID: "ses-a", name: " Build ", color: "Blue" })
    expect(saved.writes()).toBe(1)
    const id = firstTag().id
    await act({ type: "assign", sessionID: "ses-b", id, assigned: true })
    await act({ type: "update", id, patch: { name: " Release ", color: "Green" } })
    await act({ type: "assign", sessionID: "ses-a", id, assigned: false })

    initSessionTags(saved.state)

    expect(sessionTags()).toEqual({
      tags: [{ id, name: "Release", color: "Green" }],
      sessions: { "ses-b": [id] },
    })

    await act({ type: "delete", id })
    expect(sessionTags()).toEqual({ tags: [], sessions: {} })
    expect(saved.data.get("sessionTags")).toEqual({ tags: [], sessions: {} })
  })

  it("rejects invalid and malformed requests without changing persisted state", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" })
    const tag = firstTag()
    const writes = saved.writes()

    expect(await act({ type: "create", sessionID: "ses-a", name: "  ", color: "Blue" })).toMatchObject({
      ok: false,
      error: "name",
    })
    expect(await act({ type: "create", sessionID: "ses-a", name: " alpha ", color: "Blue" })).toMatchObject({
      ok: false,
      error: "duplicate",
    })
    expect(await act({ type: "create", sessionID: "ses-a", name: "Beta", color: "Cerulean" })).toMatchObject({
      ok: false,
      error: "invalid",
    })
    expect(await act({ type: "create", sessionID: "", name: "Beta", color: "Blue" })).toMatchObject({
      ok: false,
      error: "invalid",
    })
    expect(await act({ type: "create", sessionID: "cloud:ses-a", name: "Beta", color: "Blue" })).toMatchObject({
      ok: false,
      error: "invalid",
    })
    expect(await act({ type: "assign", sessionID: "ses-a", id: "missing", assigned: true })).toMatchObject({
      ok: false,
      error: "missing",
    })
    expect(await act({ type: "update", id: "missing", patch: { name: "Beta" } })).toMatchObject({
      ok: false,
      error: "missing",
    })
    expect(await act({ type: "update", id: tag.id, patch: { color: "Cerulean" } })).toMatchObject({
      ok: false,
      error: "invalid",
    })
    expect(await act(null)).toMatchObject({ type: "sessionTagResult", ok: false, error: "invalid" })
    expect(await act({ type: "assign", sessionID: "ses-a", id: tag.id, assigned: true })).toMatchObject({
      ok: true,
    })
    expect(await act({ type: "assign", sessionID: "ses-b", id: tag.id, assigned: false })).toMatchObject({
      ok: true,
    })

    const out: unknown[] = []
    await handleSessionTagsMessage(
      { type: "sessionTagAction", requestID: "", action: { type: "delete", id: tag.id } },
      (message) => out.push(message),
    )
    expect(out).toEqual([])
    expect(saved.writes()).toBe(writes)
    expect(sessionTags()).toEqual({ tags: [tag], sessions: { "ses-a": [tag.id] } })
  })

  it("serializes concurrent assignments and independent name and color patches", async () => {
    await act({ type: "create", sessionID: "ses-seed", name: "First", color: "Blue" })
    const first = firstTag()
    await act({ type: "create", sessionID: "ses-seed", name: "Second", color: "Red" })
    const second = sessionTags().tags.at(1)
    if (!second) throw new Error("Expected a second saved session tag")

    await Promise.all([
      act({ type: "assign", sessionID: "ses-a", id: first.id, assigned: true }, [], "a"),
      act({ type: "assign", sessionID: "ses-a", id: second.id, assigned: true }, [], "b"),
      act({ type: "assign", sessionID: "ses-b", id: first.id, assigned: true }, [], "c"),
      act({ type: "update", id: first.id, patch: { name: "Renamed" } }, [], "d"),
      act({ type: "update", id: first.id, patch: { color: "Cyan" } }, [], "e"),
    ])

    expect(sessionTags()).toEqual({
      tags: [{ id: first.id, name: "Renamed", color: "Cyan" }, second],
      sessions: {
        "ses-seed": [first.id, second.id],
        "ses-a": [first.id, second.id],
        "ses-b": [first.id],
      },
    })
  })

  it("keeps the old snapshot after a failed write and accepts the next operation", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" })
    const before = sessionTags()
    const id = firstTag().id
    const out: unknown[] = []
    const seen: unknown[] = []
    const off = onSessionTagsChanged((value) => seen.push(value))
    const error = spyOn(console, "error").mockImplementation(() => {})
    saved.fail()

    try {
      await act({ type: "update", id, patch: { name: "Beta" } }, out, "failed")
      expect(out).toEqual([{ type: "sessionTagResult", requestID: "failed", ok: false, error: "storage" }])
      expect(sessionTags()).toEqual(before)
      expect(saved.data.get("sessionTags")).toEqual(before)
      expect(seen).toEqual([])

      await act({ type: "update", id, patch: { color: "Green" } }, out, "next")
      expect(sessionTags().tags).toEqual([{ id, name: "Alpha", color: "Green" }])
      expect(out.at(-1)).toEqual({ type: "sessionTagResult", requestID: "next", ok: true })
      expect(seen).toEqual([{ tags: [{ id, name: "Alpha", color: "Green" }], sessions: { "ses-a": [id] } }])
      expect(error).toHaveBeenCalled()
    } finally {
      off()
      error.mockRestore()
    }
  })

  it("serializes session cleanup and makes duplicate cleanup a no-op", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" })
    const id = firstTag().id
    const writes = saved.writes()

    await Promise.all([
      act({ type: "assign", sessionID: "ses-b", id, assigned: true }, [], "assign"),
      removeSessionTags("ses-b"),
      removeSessionTags("ses-b"),
    ])

    expect(sessionTags()).toEqual({
      tags: [{ id, name: "Alpha", color: "Blue" }],
      sessions: { "ses-a": [id] },
    })
    expect(saved.writes()).toBe(writes + 2)
  })

  it("contains cleanup write failures and keeps later operations usable", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" })
    const id = firstTag().id
    const before = sessionTags()
    const error = spyOn(console, "error").mockImplementation(() => {})
    saved.fail()

    try {
      await expect(removeSessionTags("ses-a")).resolves.toBeUndefined()
      expect(sessionTags()).toEqual(before)
      await act({ type: "assign", sessionID: "ses-b", id, assigned: true })
      expect(sessionTags()).toEqual({
        tags: [{ id, name: "Alpha", color: "Blue" }],
        sessions: { "ses-a": [id], "ses-b": [id] },
      })
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("isolates listener and reply delivery failures from saved changes", async () => {
    const seen: unknown[] = []
    const offA = onSessionTagsChanged(() => {
      throw new Error("listener failed")
    })
    const offB = onSessionTagsChanged((state) => seen.push(state))
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      await expect(
        handleSessionTagsMessage(
          {
            type: "sessionTagAction",
            requestID: "reply-fails",
            action: { type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" },
          },
          () => {
            throw new Error("delivery failed")
          },
        ),
      ).resolves.toBe(true)

      const tag = firstTag()
      expect(seen).toEqual([{ tags: [{ id: tag.id, name: "Alpha", color: "Blue" }], sessions: { "ses-a": [tag.id] } }])
      expect(tag).toMatchObject({ name: "Alpha", color: "Blue" })
      expect(error).toHaveBeenCalled()
    } finally {
      offA()
      offB()
      error.mockRestore()
    }
  })

  it("sanitizes invalid persisted entries in memory without writing on startup", () => {
    const seed = {
      tags: [
        { id: "good", name: " Alpha ", color: "Blue" },
        { id: "bad-color", name: "Bad color", color: "Cerulean" },
        { id: "duplicate-name", name: "alpha", color: "Red" },
      ],
      sessions: {
        "ses-a": ["good", "good", "unknown"],
        "cloud:ses-b": ["good"],
      },
    }
    saved = memory(seed)

    initSessionTags(saved.state)

    expect(sessionTags()).toEqual({
      tags: [{ id: "good", name: "Alpha", color: "Blue" }],
      sessions: { "ses-a": ["good"] },
    })
    expect(saved.writes()).toBe(0)
    expect(saved.data.get("sessionTags")).toEqual(seed)
  })
})
