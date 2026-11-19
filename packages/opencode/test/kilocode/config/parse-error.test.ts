import { describe, expect, test } from "bun:test"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { ConfigParse } from "../../../src/config/parse"

function capture(fn: () => unknown) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected ConfigParse.jsonc to throw")
}

describe("ConfigParse.jsonc error message", () => {
  test("shows only the failing line and never echoes the whole config", () => {
    const text = `{
  "provider": { "test": { "options": { "apiKey": "sk-test-secret-value" } } },
  "model":
}`

    const err = capture(() => ConfigParse.jsonc(text, "kilo.jsonc"))

    if (!ConfigErrorV1.JsonError.isInstance(err)) throw err
    const message = err.data.message
    expect(message).toContain("ValueExpected at line 4, column 1")
    expect(message).toContain("Line 4: }")
    expect(message).not.toContain("sk-test-secret-value")
    expect(message).not.toContain("--- JSONC Input ---")
  })
})
