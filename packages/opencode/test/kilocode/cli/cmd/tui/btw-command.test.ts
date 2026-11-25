import { describe, expect, test } from "bun:test"
import { arm, take } from "@/kilocode/cli/cmd/tui/btw-command"

describe("btw command", () => {
  test("arms a follow-up thread once", () => {
    arm("ses_1", "btw_t")
    expect(take("ses_1")).toBe("btw_t")
    expect(take("ses_1")).toBeUndefined()
  })

  test("keeps armed threads separate per session", () => {
    arm("ses_1", "btw_a")
    arm("ses_2", "btw_b")
    expect(take("ses_1")).toBe("btw_a")
    expect(take("ses_2")).toBe("btw_b")
    expect(take("ses_1")).toBeUndefined()
  })

  test("a newer arm replaces the previous thread", () => {
    arm("ses_1", "btw_a")
    arm("ses_1", "btw_b")
    expect(take("ses_1")).toBe("btw_b")
  })
})
