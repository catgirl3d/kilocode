import { describe, it, expect, beforeEach, spyOn } from "bun:test"
import type { Memento } from "vscode"
import {
  initSessionColors,
  onSessionColorsChanged,
  removeSessionColor,
  sessionColors,
  setSessionColor,
} from "../../src/session-colors"

const fakeMemento = () => {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      data.set(key, value)
    },
    keys: () => [...data.keys()],
    setKeysForSync: () => {},
  } as unknown as Memento
}

describe("session colors store", () => {
  beforeEach(() => {
    initSessionColors(fakeMemento())
  })

  it("sets and clears a color per session", async () => {
    await setSessionColor("ses-a", "Red")
    expect(sessionColors()).toEqual({ "ses-a": "Red" })

    await setSessionColor("ses-a", null)
    expect(sessionColors()).toEqual({})
  })

  it("keeps colors of other sessions when clearing one", async () => {
    await setSessionColor("ses-a", "Red")
    await setSessionColor("ses-b", "Blue")

    await setSessionColor("ses-a", null)

    expect(sessionColors()).toEqual({ "ses-b": "Blue" })
  })

  it("persists colors across a memento reload", async () => {
    const state = fakeMemento()
    initSessionColors(state)
    await setSessionColor("ses-a", "Green")

    initSessionColors(state)

    expect(sessionColors()).toEqual({ "ses-a": "Green" })
  })

  it("drops invalid persisted entries when reading", async () => {
    const state = fakeMemento()
    await state.update("sessionColors", { good: "Red", bad: 42, empty: "" })
    initSessionColors(state)

    expect(sessionColors()).toEqual({ good: "Red" })
  })

  it("notifies listeners with the next map and stops after unsubscribe", async () => {
    const seen: Array<Record<string, string>> = []
    const unsub = onSessionColorsChanged((colors) => seen.push(colors))

    await setSessionColor("ses-a", "Red")
    await removeSessionColor("ses-a")
    unsub()
    await setSessionColor("ses-b", "Blue")

    expect(seen).toEqual([{ "ses-a": "Red" }, {}])
  })

  it("removes the color of a deleted session", async () => {
    await setSessionColor("ses-a", "Purple")

    await removeSessionColor("ses-a")

    expect(sessionColors()).toEqual({})
  })

  it("ignores empty color values", async () => {
    const seen: Array<Record<string, string>> = []
    const unsub = onSessionColorsChanged((colors) => seen.push(colors))

    await setSessionColor("ses-a", "")
    unsub()

    expect(sessionColors()).toEqual({})
    expect(seen).toEqual([])
  })

  it("handles prototype-named session ids without polluting state", async () => {
    await setSessionColor("__proto__", "Red")
    await setSessionColor("constructor", "Blue")

    expect(Object.hasOwn(sessionColors(), "__proto__")).toBe(true)
    expect(sessionColors()["__proto__"]).toBe("Red")
    expect(sessionColors().constructor).toBe("Blue")

    await setSessionColor("__proto__", null)
    await removeSessionColor("constructor")

    expect(sessionColors()).toEqual({})
  })

  it("does not notify when clearing a missing prototype-named key", async () => {
    const seen: unknown[] = []
    const unsub = onSessionColorsChanged((colors) => seen.push(colors))

    await removeSessionColor("constructor")
    unsub()

    expect(seen).toEqual([])
  })

  it("keeps the persisted map and notifies it when writing fails", async () => {
    const state = fakeMemento()
    await state.update("sessionColors", { a: "Red" })
    initSessionColors({
      ...state,
      update: async () => {
        throw new Error("write failed")
      },
    } as unknown as Memento)

    const seen: Array<Record<string, string>> = []
    const unsub = onSessionColorsChanged((colors) => seen.push(colors))
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await setSessionColor("a", "Blue")
    const errors = spy.mock.calls.length
    spy.mockRestore()
    unsub()

    expect(errors).toBeGreaterThan(0)
    expect(sessionColors()).toEqual({ a: "Red" })
    expect(seen).toEqual([{ a: "Red" }])
  })
})
