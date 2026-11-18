import { describe, expect, test } from "bun:test"
import { parse, type ParseError } from "jsonc-parser"
import { KilocodeJsonc } from "../../../src/kilocode/config/jsonc"

function read(text: string) {
  const errors: ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  expect(errors).toEqual([])
  return data
}

describe("KilocodeJsonc.remove", () => {
  test("deletes the only key of an object followed by a trailing comma", () => {
    const text = `{
  "provider": {
    "test3": { "a": 1 },
  },
}
`

    const out = KilocodeJsonc.remove(text, ["provider", "test3"])

    expect(read(out)).toEqual({ provider: {} })
  })

  test("keeps a line comment that follows the trailing comma", () => {
    const text = `{
  "provider": {
    "test3": { "a": 1 }, // note
  },
}
`

    const out = KilocodeJsonc.remove(text, ["provider", "test3"])

    expect(read(out)).toEqual({ provider: {} })
    expect(out).toContain("// note")
  })

  test("keeps a block comment placed before the trailing comma", () => {
    const text = `{
  "p": {
    "a": 1 /* x */,
  },
}
`

    const out = KilocodeJsonc.remove(text, ["p", "a"])

    expect(read(out)).toEqual({ p: {} })
    expect(out).toContain("/* x */")
  })

  test("removes the last of two keys that ends with a trailing comma", () => {
    const text = `{
  "p": {
    "a": 1, "b": 2,
  },
}
`

    const out = KilocodeJsonc.remove(text, ["p", "b"])

    expect(read(out)).toEqual({ p: { a: 1 } })
  })

  test("removes the first of two keys that ends with a trailing comma", () => {
    const text = `{
  "p": {
    "a": 1, "b": 2,
  },
}
`

    const out = KilocodeJsonc.remove(text, ["p", "a"])

    expect(read(out)).toEqual({ p: { b: 2 } })
  })

  test("removes the only nested key that ends with a trailing comma", () => {
    const text = `{
  "agent": {
    "explore": {
      "model": "kilo/x",
    },
  },
}
`

    const out = KilocodeJsonc.remove(text, ["agent", "explore", "model"])

    expect(read(out)).toEqual({ agent: { explore: {} } })
  })

  test("removes top-level keys in sequence from a trailing-comma object", () => {
    const text = `{
  "theme": "dark",
  "keybinds": { "leader": "ctrl+x" },
}
`

    const first = KilocodeJsonc.remove(text, ["theme"])
    const second = KilocodeJsonc.remove(first, ["keybinds"])

    expect(read(second)).toEqual({})
  })

  test("returns the input unchanged when the key or its parent is absent", () => {
    const text = '{ "a": 1 }'

    expect(KilocodeJsonc.remove(text, ["b"])).toBe(text)
    expect(KilocodeJsonc.remove(text, ["x", "y"])).toBe(text)
  })

  test("removes the last array element that ends with a trailing comma", () => {
    const text = '{ "x": ["a", "b",] }'

    const out = KilocodeJsonc.remove(text, ["x", 1])

    expect(read(out)).toEqual({ x: ["a"] })
  })
})
