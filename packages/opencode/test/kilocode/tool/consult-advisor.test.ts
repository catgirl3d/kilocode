import { describe, expect, test } from "bun:test"
import { acquire, release } from "../../../src/kilocode/tool/consult-advisor"

describe("consult advisor", () => {
  test("guards concurrent consultations per session and releases the guard", () => {
    expect(acquire("session")).toBe(true)
    expect(acquire("session")).toBe(false)
    release("session")
    expect(acquire("session")).toBe(true)
    release("session")
  })
})
