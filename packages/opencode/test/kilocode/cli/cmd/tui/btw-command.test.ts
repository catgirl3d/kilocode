import { describe, expect, test } from "bun:test"
import { arm, take } from "@/kilocode/cli/cmd/tui/btw-command"

describe("btw command", () => {
  test("arms a follow-up thread once", () => {
    arm("ses_1", "btw_t")
    expect(take("ses_1")).toBe("btw_t")
    expect(take("ses_1")).toBeUndefined()
  })
})
