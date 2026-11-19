import { describe, expect, test } from "bun:test"
import { mergeBtw, parseBtwCommand, quoteBtw } from "@opencode-ai/core/kilocode/btw/client"

describe("parseBtwCommand", () => {
  test("parses a question, keeping its lines", () => {
    expect(parseBtwCommand("/btw why is it slow?")).toEqual({ kind: "ask", question: "why is it slow?" })
    expect(parseBtwCommand("/btw a\nb")).toEqual({ kind: "ask", question: "a\nb" })
  })
  test("opens history without a question", () => {
    expect(parseBtwCommand("  /btw  ")).toEqual({ kind: "history" })
  })
  test("ignores other commands", () => {
    expect(parseBtwCommand("/btwx q")).toBeUndefined()
    expect(parseBtwCommand("btw q")).toBeUndefined()
  })
})

describe("quoteBtw", () => {
  test("quotes question and answer", () => {
    expect(quoteBtw({ question: "q", answer: "line1\nline2" })).toBe("> **Side question:** q\n>\n> line1\n> line2\n\n")
  })
  test("quotes every line of a multi-line question", () => {
    expect(quoteBtw({ question: "why\nis it\nslow?", answer: "a" })).toBe(
      "> **Side question:** why\n> is it\n> slow?\n>\n> a\n\n",
    )
  })
})

describe("mergeBtw", () => {
  test("never replaces a terminal record with a running copy", () => {
    expect(mergeBtw({ status: "done", answer: "abc" }, { status: "running", answer: "abcdef" })).toEqual({
      status: "done",
      answer: "abc",
    })
  })
  test("keeps the longer answer while both copies are running", () => {
    expect(mergeBtw({ status: "running", answer: "abc" }, { status: "running", answer: "a" }).answer).toBe("abc")
    expect(mergeBtw({ status: "running", answer: "abc" }, { status: "running", answer: "abcd" }).answer).toBe("abcd")
  })
  test("takes a terminal copy over a running one", () => {
    expect(mergeBtw({ status: "running", answer: "abc" }, { status: "done", answer: "a" }).status).toBe("done")
  })
})
