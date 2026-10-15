import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { Memento } from "vscode"
import {
  handleSessionTagsMessage,
  initSessionTags,
  onSessionTagsChanged,
  refreshSessionTags,
  removeSessionTags,
  sessionTags,
  sessionTagsFor,
} from "../../src/session-tags"
import type { SessionTag, SessionTagsState } from "../../webview-ui/src/types/messages/sessions"

type StoredState = {
  version: 2
  global: SessionTag[]
  projects: Record<string, { tags: SessionTag[]; sessions: Record<string, string[]> }>
  legacy: { sessions: Record<string, string[]> }
}

const DEFAULT_PROJECT = Symbol("default project")
const NO_PROJECT = Symbol("no project")

function memory(seed?: unknown) {
  const data = new Map<string, unknown>()
  if (seed !== undefined) data.set("sessionTags", seed)
  const counts = new Map<string, number>()
  let writes = 0
  let fail: string | undefined
  return {
    data,
    writes: () => writes,
    writesFor: (key: string) => counts.get(key) ?? 0,
    fail: (key?: string) => (fail = key ?? "*"),
    state: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        writes++
        counts.set(key, (counts.get(key) ?? 0) + 1)
        if (fail === "*" || fail === key) {
          fail = undefined
          throw new Error("write failed")
        }
        data.set(key, value)
      },
      keys: () => [...data.keys()],
      setKeysForSync: () => {},
    } as unknown as Memento,
  }
}

async function act(
  action: unknown,
  project: string | undefined | typeof DEFAULT_PROJECT | typeof NO_PROJECT = DEFAULT_PROJECT,
  requestID = "request",
  out: unknown[] = [],
) {
  const scope = project === DEFAULT_PROJECT ? "p1" : project === NO_PROJECT ? undefined : project
  await handleSessionTagsMessage({ type: "sessionTagAction", requestID, action }, (message) => out.push(message), scope)
  return out.at(-1)
}

function tag(project = "p1", name?: string): SessionTag {
  const value = sessionTagsFor(project).tags.find((item) => name === undefined || item.name === name)
  if (!value) throw new Error("Expected a saved session tag")
  return value
}

function state(
  global: SessionTag[] = [],
  projects: StoredState["projects"] = {},
  legacy: string[][] = [],
): StoredState {
  return {
    version: 2,
    global,
    projects,
    legacy: { sessions: Object.fromEntries(legacy.map(([sessionID, ...ids]) => [sessionID, ids])) },
  }
}

describe("session tags store", () => {
  let saved: ReturnType<typeof memory>

  beforeEach(() => {
    saved = memory()
    initSessionTags(saved.state)
  })

  it("migrates v1 to project views and backs up the raw blob before the first mutation", async () => {
    const seed = {
      tags: [{ id: "global", name: "Global", color: "Blue" }],
      sessions: { "ses-a": ["global", "global"], "ses-b": ["global", "unknown"] },
    }
    saved = memory(seed)
    initSessionTags(saved.state)

    expect(saved.writes()).toBe(0)
    expect(sessionTagsFor("p1")).toEqual({
      tags: [{ id: "global", name: "Global", color: "Blue", scope: "global" }],
      sessions: { "ses-a": ["global"], "ses-b": ["global"] },
    })
    expect(sessionTagsFor("p2")).toEqual(sessionTagsFor("p1"))

    await act({ type: "assign", sessionID: "ses-c", id: "global", assigned: true }, "p1", "first")
    expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
    expect(saved.data.get("sessionTags")).toEqual({
      version: 2,
      global: [{ id: "global", name: "Global", color: "Blue", scope: "global" }],
      projects: { p1: { tags: [], sessions: { "ses-c": ["global"] } } },
      legacy: { sessions: { "ses-a": ["global"], "ses-b": ["global"] } },
    })
    expect(saved.writes()).toBe(2)

    await act({ type: "assign", sessionID: "ses-d", id: "global", assigned: true }, "p1", "second")
    expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
    expect(saved.writes()).toBe(3)
  })

  it("backs up v1 before removeSessionTags and does not write during init", async () => {
    const seed = {
      tags: [{ id: "global", name: "Global", color: "Blue" }],
      sessions: { "ses-a": ["global"] },
    }
    saved = memory(seed)
    initSessionTags(saved.state)

    await removeSessionTags("ses-a")

    expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
    expect(saved.data.get("sessionTags")).toEqual({
      version: 2,
      global: [{ id: "global", name: "Global", color: "Blue", scope: "global" }],
      projects: {},
      legacy: { sessions: {} },
    })
    expect(saved.writes()).toBe(2)
    expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)
  })

  it("uses an empty v2 state for absent and garbage values without writing on init", () => {
    for (const seed of [undefined, null, "garbage", { version: 1, sessions: {} }]) {
      saved = memory(seed)
      initSessionTags(saved.state)
      expect(sessionTags()).toEqual({ version: 2, global: [], projects: {}, legacy: { sessions: {} } })
      expect(sessionTagsFor("p1")).toEqual({ tags: [], sessions: {} })
      expect(saved.writes()).toBe(0)
    }
  })

  it("treats unsupported versions as empty and backs up the raw value once on mutation", async () => {
    const seed = {
      version: 3,
      global: [{ id: "global", name: "Global", color: "Blue" }],
      projects: {},
      legacy: { sessions: {} },
    }
    saved = memory(seed)
    initSessionTags(saved.state)

    expect(sessionTags()).toEqual({ version: 2, global: [], projects: {}, legacy: { sessions: {} } })
    expect(saved.writes()).toBe(0)

    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, "p1")

    expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
    expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)
    expect(saved.data.get("sessionTags")).toEqual({
      version: 2,
      global: [],
      projects: {
        p1: {
          tags: [expect.objectContaining({ name: "Alpha", color: "Blue" })],
          sessions: { "ses-a": [expect.any(String)] },
        },
      },
      legacy: { sessions: {} },
    })

    await act({ type: "update", id: tag("p1", "Alpha").id, patch: { name: "Renamed" } }, "p1")
    expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)
  })

  it("does not back up version-missing garbage on the first mutation", async () => {
    saved = memory({ tags: "not-an-array" })
    initSessionTags(saved.state)

    expect(sessionTags()).toEqual({ version: 2, global: [], projects: {}, legacy: { sessions: {} } })
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, "p1")

    expect(saved.data.has("sessionTags.v1-backup")).toBe(false)
    expect(saved.writesFor("sessionTags.v1-backup")).toBe(0)
  })

  it("isolates project tags, permits same names in different projects, and scopes global assignments", async () => {
    const seen: SessionTagsState[] = []
    const off = onSessionTagsChanged((view) => seen.push(view("p1")))
    try {
      await act({ type: "create", sessionID: "ses-p1", name: "Local", color: "Blue" }, "p1")
      const p1 = tag("p1", "Local")
      await act({ type: "create", sessionID: "ses-p2", name: "Local", color: "Red" }, "p2")
      const p2 = tag("p2", "Local")
      expect(p1.id).not.toBe(p2.id)
      expect(await act({ type: "create", sessionID: "ses-other", name: " local ", color: "Green" }, "p1")).toEqual(
        expect.objectContaining({ ok: false, error: "duplicate" }),
      )

      await act({ type: "create", sessionID: "ses-global", name: "Global", color: "Green", scope: "global" }, "p1")
      const global = tag("p1", "Global")
      expect(global.scope).toBe("global")
      expect(sessionTagsFor("p1")).toEqual({
        tags: [p1, { ...global, scope: "global" }],
        sessions: { "ses-p1": [p1.id], "ses-global": [global.id] },
      })
      expect(sessionTagsFor("p2")).toEqual({
        tags: [p2, { ...global, scope: "global" }],
        sessions: { "ses-p2": [p2.id] },
      })
      expect(seen.at(-1)).toEqual(sessionTagsFor("p1"))
    } finally {
      off()
    }
  })

  it("moves a global tag to the current project and scrubs other assignments and legacy data", async () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    saved = memory(
      state(
        global ? [global] : [],
        {
          p1: { tags: [], sessions: { "ses-p1": [global.id] } },
          p2: { tags: [], sessions: { "ses-p2": [global.id] } },
        },
        [["ses-legacy", global.id]],
      ),
    )
    initSessionTags(saved.state)

    expect(await act({ type: "update", id: global.id, patch: { scope: "project" } }, "p1")).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(sessionTags()).toEqual({
      version: 2,
      global: [],
      projects: {
        p1: { tags: [{ id: global.id, name: global.name, color: global.color }], sessions: { "ses-p1": [global.id] } },
        p2: { tags: [], sessions: {} },
      },
      legacy: { sessions: {} },
    })
  })

  it("moves a project tag back to global without losing assignments", async () => {
    const local = { id: "local", name: "Local", color: "Blue" }
    saved = memory(state([], { p1: { tags: [local], sessions: { "ses-p1": [local.id] } } }))
    initSessionTags(saved.state)

    await act({ type: "update", id: local.id, patch: { scope: "global" } }, "p1")
    expect(sessionTags()).toEqual({
      version: 2,
      global: [{ ...local, scope: "global" }],
      projects: { p1: { tags: [], sessions: { "ses-p1": [local.id] } } },
      legacy: { sessions: {} },
    })
  })

  it("rejects demoting a global tag when no project is selected", async () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    saved = memory(state([global]))
    initSessionTags(saved.state)
    const before = sessionTags()

    expect(await act({ type: "update", id: global.id, patch: { scope: "project" } }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "project" }),
    )
    expect(sessionTags()).toEqual(before)
    expect(saved.writes()).toBe(0)
  })

  it("treats legacy assignment as an assign no-op and removes both layers on unassign", async () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    const seed = state([global], { p1: { tags: [], sessions: {} } }, [["ses-a", global.id]])
    saved = memory(seed)
    initSessionTags(saved.state)

    const writes = saved.writes()
    const before = sessionTags()
    expect(await act({ type: "assign", sessionID: "ses-a", id: global.id, assigned: true }, "p1")).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(saved.writes()).toBe(writes)
    expect(sessionTags()).toEqual(before)
    expect(sessionTagsFor("p1").sessions).toEqual({ "ses-a": [global.id] })

    await act({ type: "assign", sessionID: "ses-a", id: global.id, assigned: false }, "p1")
    expect(sessionTags()).toEqual({
      version: 2,
      global: [global],
      projects: { p1: { tags: [], sessions: {} } },
      legacy: { sessions: {} },
    })

    saved = memory(state([global], {}, [["ses-only", global.id]]))
    initSessionTags(saved.state)
    await act({ type: "assign", sessionID: "ses-only", id: global.id, assigned: false }, "p2")
    expect(sessionTags()).toEqual({ version: 2, global: [global], projects: {}, legacy: { sessions: {} } })
  })

  it("continues the first mutation when the v1 backup write fails", async () => {
    const seed = { tags: [{ id: "global", name: "Global", color: "Blue" }], sessions: {} }
    saved = memory(seed)
    initSessionTags(saved.state)
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      saved.fail()
      await act({ type: "assign", sessionID: "ses-a", id: "global", assigned: true }, "p1")
      expect(saved.data.has("sessionTags.v1-backup")).toBe(false)
      expect(sessionTagsFor("p1").sessions).toEqual({ "ses-a": ["global"] })
      expect(error).toHaveBeenCalledWith("[Kilo New] Failed to save session tags v1 backup:", expect.any(Error))

      await act({ type: "assign", sessionID: "ses-b", id: "global", assigned: true }, "p1")
      expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)
      expect(
        error.mock.calls.filter(([message]) => message === "[Kilo New] Failed to save session tags v1 backup:"),
      ).toHaveLength(1)
    } finally {
      error.mockRestore()
    }
  })

  it("keeps the raw v1 value after a main write failure and persists a later mutation", async () => {
    const seed = {
      tags: [{ id: "global", name: "Global", color: "Blue" }],
      sessions: {},
    }
    saved = memory(seed)
    initSessionTags(saved.state)
    const before = sessionTags()
    const out: unknown[] = []
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      saved.fail("sessionTags")
      await act({ type: "assign", sessionID: "ses-a", id: "global", assigned: true }, "p1", "failed", out)

      expect(out).toEqual([{ type: "sessionTagResult", requestID: "failed", ok: false, error: "storage" }])
      expect(sessionTags()).toEqual(before)
      expect(saved.data.get("sessionTags")).toEqual(seed)
      expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
      expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)

      await act({ type: "assign", sessionID: "ses-b", id: "global", assigned: true }, "p1", "next", out)
      expect(out.at(-1)).toEqual({ type: "sessionTagResult", requestID: "next", ok: true })
      expect(saved.data.get("sessionTags")).toEqual({
        version: 2,
        global: [{ id: "global", name: "Global", color: "Blue", scope: "global" }],
        projects: { p1: { tags: [], sessions: { "ses-b": ["global"] } } },
        legacy: { sessions: {} },
      })
      expect(saved.writesFor("sessionTags.v1-backup")).toBe(1)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("drops corrupt v1 entries while backing up the exact raw seed", async () => {
    const seed = {
      tags: [
        { id: "good", name: " Good ", color: "Blue" },
        { id: "bad-color", name: "Bad", color: "Cerulean" },
        { id: "duplicate", name: "good", color: "Red" },
        null,
      ],
      sessions: {
        "ses-good": ["good", "good", "unknown"],
        "cloud:ses": ["good"],
        broken: "not-an-array",
      },
    }
    saved = memory(seed)
    initSessionTags(saved.state)

    expect(sessionTagsFor("p1")).toEqual({
      tags: [{ id: "good", name: "Good", color: "Blue", scope: "global" }],
      sessions: { "ses-good": ["good"] },
    })
    await act({ type: "assign", sessionID: "ses-next", id: "good", assigned: true }, "p1")

    expect(saved.data.get("sessionTags.v1-backup")).toEqual(seed)
  })

  it("deletes a tag and scrubs every project and legacy assignment", async () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    saved = memory(
      state(
        [global],
        {
          p1: { tags: [], sessions: { "ses-p1": [global.id] } },
          p2: { tags: [], sessions: { "ses-p2": [global.id] } },
        },
        [["ses-legacy", global.id]],
      ),
    )
    initSessionTags(saved.state)

    await act({ type: "delete", id: global.id }, "p1")
    expect(sessionTags()).toEqual({
      version: 2,
      global: [],
      projects: { p1: { tags: [], sessions: {} }, p2: { tags: [], sessions: {} } },
      legacy: { sessions: {} },
    })
  })

  it("removes a session from legacy and all projects without writing for a no-op", async () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    const local = { id: "local", name: "Local", color: "Red" }
    saved = memory(
      state(
        [global],
        {
          p1: { tags: [local], sessions: { "ses-a": [local.id], "ses-b": [local.id] } },
          p2: { tags: [], sessions: { "ses-a": [global.id] } },
        },
        [["ses-a", global.id]],
      ),
    )
    initSessionTags(saved.state)

    await removeSessionTags("ses-a")
    expect(sessionTags()).toEqual({
      version: 2,
      global: [global],
      projects: {
        p1: { tags: [local], sessions: { "ses-b": [local.id] } },
        p2: { tags: [], sessions: {} },
      },
      legacy: { sessions: {} },
    })
    const writes = saved.writes()
    await removeSessionTags("ses-a")
    expect(saved.writes()).toBe(writes)
  })

  it("preserves an external tag when cleanup writes from a stale local snapshot", async () => {
    const y = { id: "y", name: "Y", color: "Blue" }
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    saved = memory(state([], { p1: { tags: [y], sessions: { "ses-y": [y.id] } } }))
    initSessionTags(saved.state)

    await saved.state.update(
      "sessionTags",
      state([], {
        p1: {
          tags: [y, ref1],
          sessions: { "ses-y": [y.id], "ses-ref1": [ref1.id] },
        },
      }),
    )
    await removeSessionTags("ses-y")

    const result = saved.data.get("sessionTags") as StoredState
    expect(result.projects.p1?.tags).toEqual([y, ref1])
    expect(result.projects.p1?.sessions).toEqual({ "ses-ref1": [ref1.id] })
  })

  it("refreshes state and publishes once without writing the external snapshot after queued work settles", async () => {
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    saved = memory(state())
    initSessionTags(saved.state)
    const seen: SessionTagsState[] = []
    const off = onSessionTagsChanged((view) => seen.push(view("p1")))

    try {
      await saved.state.update("sessionTags", state([], { p1: { tags: [ref1], sessions: {} } }))
      const writes = saved.writesFor("sessionTags")

      refreshSessionTags()
      await removeSessionTags("ses-flush")
      expect(sessionTagsFor("p1")).toEqual({ tags: [ref1], sessions: {} })
      expect(seen).toEqual([{ tags: [ref1], sessions: {} }])
      expect(saved.writesFor("sessionTags")).toBe(writes)

      refreshSessionTags()
      await removeSessionTags("ses-flush")
      expect(seen).toHaveLength(1)
      expect(saved.writesFor("sessionTags")).toBe(writes)
    } finally {
      off()
    }
  })

  it("refreshes state for a no-op action after an external update", async () => {
    const y = { id: "y", name: "Y", color: "Blue" }
    const ref1 = { id: "ref1", name: "Ref 1", color: "Red" }
    saved = memory(state([], { p1: { tags: [y], sessions: { "ses-y": [y.id] } } }))
    initSessionTags(saved.state)
    const seen: SessionTagsState[] = []
    const off = onSessionTagsChanged((view) => seen.push(view("p1")))

    try {
      await saved.state.update("sessionTags", state([], { p1: { tags: [y, ref1], sessions: { "ses-y": [y.id] } } }))
      const writes = saved.writesFor("sessionTags")

      await act({ type: "assign", sessionID: "ses-y", id: y.id, assigned: true }, "p1")

      expect(sessionTagsFor("p1").tags).toEqual([y, ref1])
      expect(seen).toEqual([{ tags: [y, ref1], sessions: { "ses-y": [y.id] } }])
      expect(saved.writesFor("sessionTags")).toBe(writes)
    } finally {
      off()
    }
  })

  it("contains cleanup failures and keeps the write queue usable", async () => {
    const local = { id: "local", name: "Local", color: "Blue" }
    const seed = state([], { p1: { tags: [local], sessions: { "ses-a": [local.id] } } })
    saved = memory(seed)
    initSessionTags(saved.state)
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      saved.fail()
      await expect(removeSessionTags("ses-a")).resolves.toBeUndefined()
      expect(sessionTags()).toEqual(seed)
      await act({ type: "assign", sessionID: "ses-b", id: local.id, assigned: true }, "p1")
      expect(sessionTagsFor("p1").sessions).toEqual({ "ses-a": [local.id], "ses-b": [local.id] })
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("rejects create and assign without a project without writing", async () => {
    expect(await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "project" }),
    )
    expect(await act({ type: "assign", sessionID: "ses-a", id: "missing", assigned: true }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "missing" }),
    )
    expect(saved.writes()).toBe(0)
    expect(saved.data.has("sessionTags")).toBe(false)
  })

  it("validates payloads before requiring a project and preserves state on rejection", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, "p1")
    await act({ type: "create", sessionID: "ses-b", name: "Beta", color: "Red" }, "p1")
    await act({ type: "create", sessionID: "ses-global", name: "Global", color: "Green", scope: "global" }, "p1")
    const id = tag("p1").id
    const globalID = tag("p1", "Global").id
    const before = sessionTags()
    const writes = saved.writes()

    const invalid = [
      [null, "invalid"],
      [{ type: "create", sessionID: 1, name: "Beta", color: "Blue" }, "invalid"],
      [{ type: "create", sessionID: "", name: "Beta", color: "Blue" }, "invalid"],
      [{ type: "create", sessionID: "cloud:ses", name: "Beta", color: "Blue" }, "invalid"],
      [{ type: "create", sessionID: "ses-b", name: "Beta", color: "Cerulean" }, "invalid"],
      [{ type: "create", sessionID: "ses-b", name: " ", color: "Blue" }, "name"],
      [{ type: "update", id, patch: null }, "invalid"],
      [{ type: "update", id, patch: { color: "Cerulean" } }, "invalid"],
      [{ type: "update", id, patch: { name: " beta " } }, "duplicate"],
      [{ type: "update", id: "unknown", patch: { name: "Beta" } }, "missing"],
      [{ type: "assign", sessionID: 1, id, assigned: true }, "invalid"],
      [{ type: "assign", sessionID: "ses-b", id, assigned: "yes" }, "invalid"],
      [{ type: "assign", sessionID: "ses-b", id: "missing", assigned: true }, "missing"],
      [{ type: "delete", id: 1 }, "missing"],
      [{ type: "delete", id: "unknown" }, "missing"],
    ] as const
    for (const [action, error] of invalid) {
      expect(await act(action, "p1")).toEqual(expect.objectContaining({ ok: false, error }))
    }

    expect(await act({ type: "create", sessionID: "ses-b", name: "Beta", color: "Blue" }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "project" }),
    )
    expect(await act({ type: "create", sessionID: "", name: "Beta", color: "Blue" }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "invalid" }),
    )
    expect(await act({ type: "create", sessionID: "ses-b", name: " ", color: "Blue" }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "name" }),
    )
    expect(await act({ type: "assign", sessionID: "ses-b", id: "missing", assigned: true }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "missing" }),
    )
    expect(await act({ type: "assign", sessionID: "", id, assigned: true }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "invalid" }),
    )
    expect(await act({ type: "assign", sessionID: "ses-b", id: globalID, assigned: true }, NO_PROJECT)).toEqual(
      expect.objectContaining({ ok: false, error: "project" }),
    )

    expect(saved.writes()).toBe(writes)
    expect(sessionTags()).toEqual(before)
  })

  it("rejects unsupported create and update scopes without writing or changing state", async () => {
    await act({ type: "create", sessionID: "ses-existing", name: "Existing", color: "Blue" }, "p1")
    const id = tag("p1", "Existing").id
    const before = sessionTags()
    const writes = saved.writes()

    for (const action of [
      { type: "create", sessionID: "ses-a", name: "Everywhere", color: "Blue", scope: "everywhere" },
      { type: "create", sessionID: "ses-b", name: "Numeric", color: "Red", scope: 123 },
      { type: "update", id, patch: { scope: "nope" } },
    ]) {
      expect(await act(action, "p1")).toEqual(expect.objectContaining({ ok: false, error: "invalid" }))
    }

    expect(saved.writes()).toBe(writes)
    expect(sessionTags()).toEqual(before)
  })

  it("sanitizes v2 projects, tags, session IDs, and assignment IDs", () => {
    const seed = {
      version: 2,
      global: [
        { id: "global", name: "Global", color: "Blue" },
        { id: "global", name: "Other", color: "Red" },
        { id: "global-name", name: "global", color: "Green" },
      ],
      projects: {
        "": { tags: [{ id: "empty", name: "Empty", color: "Blue" }], sessions: {} },
        ["x".repeat(201)]: { tags: [], sessions: {} },
        p1: {
          tags: [
            { id: "local", name: "Local", color: "Red" },
            { id: "local", name: "Other", color: "Green" },
            { id: "local-name", name: "local", color: "Blue" },
          ],
          sessions: { "ses-a": ["local", "global", "local", "unknown"], "cloud:ses": ["local"] },
        },
      },
      legacy: { sessions: { "ses-b": ["global", "local", "global"], "ses-c": ["global"] } },
    }
    saved = memory(seed)
    initSessionTags(saved.state)

    expect(sessionTags()).toEqual({
      version: 2,
      global: [{ id: "global", name: "Global", color: "Blue", scope: "global" }],
      projects: {
        p1: {
          tags: [{ id: "local", name: "Local", color: "Red" }],
          sessions: { "ses-a": ["local", "global"] },
        },
      },
      legacy: { sessions: { "ses-b": ["global"], "ses-c": ["global"] } },
    })
    expect(saved.writes()).toBe(0)
  })

  it("drops dangling project and legacy assignments without mutating the supplied state", () => {
    const global = { id: "global", name: "Global", color: "Blue", scope: "global" as const }
    const local = { id: "local", name: "Local", color: "Red" }
    const value = state(
      [global],
      {
        p1: {
          tags: [local],
          sessions: { "ses-project": [local.id, "missing", local.id], "ses-empty": ["missing"] },
        },
      },
      [
        ["ses-legacy", "missing", global.id, global.id],
        ["ses-empty-legacy", "missing"],
      ],
    )
    const before = JSON.parse(JSON.stringify(value))

    expect(sessionTagsFor("p1", value)).toEqual({
      tags: [local, global],
      sessions: { "ses-legacy": [global.id], "ses-project": [local.id] },
    })
    expect(value).toEqual(before)
  })

  it("preserves prototype-looking project and session keys without pollution", async () => {
    const projects = Object.fromEntries([
      [
        "__proto__",
        {
          tags: [{ id: "proto", name: "Proto", color: "Blue" }],
          sessions: Object.fromEntries([["__proto__", ["proto"]]]),
        },
      ],
      ["constructor", { tags: [{ id: "constructor", name: "Constructor", color: "Red" }], sessions: {} }],
      ["toString", { tags: [{ id: "toString", name: "ToString", color: "Green" }], sessions: {} }],
      ["hasOwnProperty", { tags: [{ id: "has-own", name: "HasOwn", color: "Yellow" }], sessions: {} }],
    ])
    saved = memory({ version: 2, global: [], projects, legacy: { sessions: {} } })
    initSessionTags(saved.state)

    const stored = sessionTags()
    expect(Object.getPrototypeOf(stored.projects)).toBe(Object.prototype)
    expect(Object.keys(stored.projects)).toEqual(["__proto__", "constructor", "toString", "hasOwnProperty"])
    expect(Object.hasOwn(stored.projects, "__proto__")).toBe(true)
    expect(sessionTagsFor("__proto__")).toEqual({
      tags: [{ id: "proto", name: "Proto", color: "Blue" }],
      sessions: Object.fromEntries([["__proto__", ["proto"]]]),
    })
    expect(Object.hasOwn(sessionTagsFor("__proto__").sessions, "__proto__")).toBe(true)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()

    expect(await act({ type: "create", sessionID: "ses-new", name: "Created", color: "Blue" }, "__proto__")).toEqual(
      expect.objectContaining({ ok: true }),
    )
    const created = tag("__proto__", "Created")
    expect(await act({ type: "assign", sessionID: "ses-assigned", id: "proto", assigned: true }, "__proto__")).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(await act({ type: "update", id: "proto", patch: { name: "Renamed" } }, "__proto__")).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(await act({ type: "delete", id: "proto" }, "__proto__")).toEqual(expect.objectContaining({ ok: true }))
    expect(sessionTagsFor("__proto__").tags).toContainEqual(created)
    expect(sessionTagsFor("__proto__").sessions).toEqual({ "ses-new": [created.id] })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(JSON.parse(JSON.stringify(sessionTags()))).toEqual(sessionTags())
    expect(JSON.parse(JSON.stringify(sessionTagsFor("__proto__")))).toEqual(sessionTagsFor("__proto__"))
  })

  it("resets backup tracking when initialized with a different Memento", async () => {
    const first = memory({ tags: [{ id: "old", name: "Old", color: "Blue" }], sessions: {} })
    initSessionTags(first.state)
    await act({ type: "assign", sessionID: "ses-old", id: "old", assigned: true }, "p1")
    expect(first.data.has("sessionTags.v1-backup")).toBe(true)

    saved = memory(state())
    initSessionTags(saved.state)
    await act({ type: "create", sessionID: "ses-new", name: "New", color: "Blue" }, "p2")

    expect(saved.data.has("sessionTags.v1-backup")).toBe(false)
    expect(saved.data.get("sessionTags")).toEqual({
      version: 2,
      global: [],
      projects: {
        p2: { tags: [expect.objectContaining({ name: "New" })], sessions: { "ses-new": [expect.any(String)] } },
      },
      legacy: { sessions: {} },
    })
  })

  it("serializes mixed concurrent writes without dangling assignments", async () => {
    const keep = { id: "keep", name: "Keep", color: "Blue" }
    saved = memory(state([], { p1: { tags: [keep], sessions: { "ses-old": [keep.id] } } }))
    initSessionTags(saved.state)

    await Promise.all([
      act({ type: "create", sessionID: "ses-created", name: "Created", color: "Red" }, "p1"),
      act({ type: "assign", sessionID: "ses-assigned", id: keep.id, assigned: true }, "p1"),
      act({ type: "delete", id: keep.id }, "p1"),
      removeSessionTags("ses-created"),
    ])

    const result = sessionTags()
    expect(result.projects.p1?.tags).toEqual([expect.objectContaining({ name: "Created" })])
    expect(result.projects.p1?.sessions).toEqual({})
    expect(JSON.stringify(result)).not.toContain(keep.id)
    expect(saved.data.get("sessionTags")).toEqual(result)
  })

  it("does not expose mutable snapshots or project views", async () => {
    await act({ type: "create", sessionID: "ses-local", name: "Local", color: "Blue" }, "p1")
    await act({ type: "create", sessionID: "ses-global", name: "Global", color: "Red", scope: "global" }, "p1")
    const expected = sessionTags()
    const expectedP1 = sessionTagsFor("p1")
    const expectedP2 = sessionTagsFor("p2")
    const snapshot = sessionTags()
    const p1 = sessionTagsFor("p1")
    const p2 = sessionTagsFor("p2")

    snapshot.projects.p1!.tags[0]!.name = "changed"
    snapshot.projects.p1!.sessions["ses-local"]!.length = 0
    p1.tags[0]!.name = "changed"
    p1.sessions["ses-local"]!.length = 0
    p2.tags.length = 0

    expect(sessionTags()).toEqual(expected)
    expect(sessionTagsFor("p1")).toEqual(expectedP1)
    expect(sessionTagsFor("p2")).toEqual(expectedP2)
  })

  it("keeps state and replies with a storage error when a mutation cannot persist", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, "p1")
    const before = sessionTags()
    const id = tag("p1").id
    const out: unknown[] = []
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      saved.fail()
      await act({ type: "update", id, patch: { name: "Beta" } }, "p1", "failed", out)
      expect(out).toEqual([{ type: "sessionTagResult", requestID: "failed", ok: false, error: "storage" }])
      expect(sessionTags()).toEqual(before)
      expect(saved.data.get("sessionTags")).toEqual(before)

      await act({ type: "update", id, patch: { color: "Green" } }, "p1", "next", out)
      expect(sessionTagsFor("p1").tags).toEqual([{ id, name: "Alpha", color: "Green" }])
      expect(out.at(-1)).toEqual({ type: "sessionTagResult", requestID: "next", ok: true })
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("isolates listener and reply-delivery failures from a committed mutation", async () => {
    const seen: SessionTagsState[] = []
    const offA = onSessionTagsChanged(() => {
      throw new Error("listener failed")
    })
    const offB = onSessionTagsChanged((view) => seen.push(view("p1")))
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
          "p1",
        ),
      ).resolves.toBe(true)

      const created = tag("p1")
      expect(seen).toEqual([sessionTagsFor("p1")])
      expect(created).toMatchObject({ name: "Alpha", color: "Blue" })
      expect(error).toHaveBeenCalledWith("[Kilo New] Session tag listener failed:", expect.any(Error))
      expect(error).toHaveBeenCalledWith("[Kilo New] Session tag message delivery failed:", expect.any(Error))
    } finally {
      offA()
      offB()
      error.mockRestore()
    }
  })

  it("returns an independent project view for request messages", async () => {
    await act({ type: "create", sessionID: "ses-a", name: "Alpha", color: "Blue" }, "p1")
    const out: unknown[] = []
    await handleSessionTagsMessage({ type: "requestSessionTags" }, (message) => out.push(message), "p1")

    expect(out).toEqual([{ type: "sessionTagsLoaded", state: sessionTagsFor("p1") }])
    const message = out[0] as { state: SessionTagsState }
    message.state.tags.length = 0
    message.state.sessions["ses-a"]!.length = 0
    expect(sessionTagsFor("p1").tags).toHaveLength(1)
    expect(sessionTagsFor("p1").sessions).toEqual({ "ses-a": [tag("p1").id] })
  })

  it("returns false and posts nothing for non-session-tag messages", async () => {
    const out: unknown[] = []

    await expect(
      handleSessionTagsMessage({ type: "notATagMessage" }, (message) => out.push(message), "p1"),
    ).resolves.toBe(false)
    expect(out).toEqual([])
  })
})
