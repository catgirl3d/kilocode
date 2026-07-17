import { describe, expect, it } from "bun:test"
import { add, kind, list, remove, toggle } from "../../webview-ui/src/utils/instruction-items"

describe("instruction items", () => {
  it("toggles entries without removing them", () => {
    const base = {
      instructions: ["./a.md", "./b.md"],
      instructions_disabled: ["./b.md"],
    }

    expect(list(base)).toEqual([
      { path: "./a.md", enabled: true, kind: "file" },
      { path: "./b.md", enabled: false, kind: "file" },
    ])
    expect(toggle(base, "./a.md", false)).toEqual({ instructions_disabled: ["./b.md", "./a.md"] })
    expect(toggle(base, "./b.md", true)).toEqual({ instructions_disabled: [] })
    expect(remove(base, "./b.md")).toEqual({ instructions: ["./a.md"], instructions_disabled: [] })
    expect(add(base, "./b.md")).toEqual({ instructions: ["./a.md", "./b.md"] })
  })

  it("classifies urls and globs safely", () => {
    expect(kind("https://example.com/rules.md")).toBe("url")
    expect(kind("docs/**/*.md")).toBe("glob")
    expect(kind("./rules.md")).toBe("file")
  })

  it("shows inherited global entries while honoring writable overrides", () => {
    const effective = {
      instructions: ["./legacy.md", "./kilo.md"],
      instructions_disabled: ["./legacy.md"],
    }
    const target = {
      instructions: ["./kilo.md", "./legacy.md"],
      instructions_disabled: ["./legacy.md"],
    }

    expect(list(effective, target)).toEqual([
      { path: "./legacy.md", enabled: false, kind: "file", owned: true },
      { path: "./kilo.md", enabled: true, kind: "file", owned: true },
    ])
  })

  it("applies the writable global toggle optimistically", () => {
    const effective = {
      instructions: ["./rules.md"],
      instructions_disabled: [],
    }
    const target = {
      instructions: ["./rules.md"],
      instructions_disabled: ["./rules.md"],
    }

    expect(list(effective, target)).toEqual([{ path: "./rules.md", enabled: false, kind: "file", owned: true }])
  })
})
