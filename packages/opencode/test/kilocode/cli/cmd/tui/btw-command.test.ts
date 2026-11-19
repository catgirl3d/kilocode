import { describe, expect, test } from "bun:test"
import { arm, parseBtwCommand, quote, take } from "@/kilocode/cli/cmd/tui/btw-command"

describe("btw command", () => {
  test("parses", () => {
    expect(parseBtwCommand("/btw why?")).toEqual({ kind: "ask", question: "why?" })
    expect(parseBtwCommand("/btw")).toEqual({ kind: "history" })
    expect(parseBtwCommand("/btwx")).toBeUndefined()
  })
  test("quotes", () => {
    expect(quote({ question: "q", answer: "a" })).toBe("> **Side question:** q\n>\n> a\n\n")
  })
  test("quotes every line of a multi-line question", () => {
    expect(quote({ question: "first\nsecond", answer: "a1\na2" })).toBe(
      "> **Side question:** first\n> second\n>\n> a1\n> a2\n\n",
    )
  })
  test("arms a follow-up thread once", () => {
    arm("ses_1", "btw_t")
    expect(take("ses_1")).toBe("btw_t")
    expect(take("ses_1")).toBeUndefined()
  })
})
