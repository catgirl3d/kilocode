import { describe, expect, test } from "bun:test"
import * as CommandCatalog from "../../../src/kilocode/command/catalog"
import type { Command } from "../../../src/command"

const legacy = {
  name: "shake",
  description: "configured shake",
  agent: "build",
  model: "test/model",
  variant: "high",
  source: "command" as const,
  trusted: true,
  template: "custom shake template",
  subtask: true,
  hints: ["$ARGUMENTS"],
} satisfies Command.Info

describe("command catalog", () => {
  test("exposes only shake as a builtin action", () => {
    expect(CommandCatalog.list([])).toEqual([
      {
        name: "shake",
        description: "clear eligible tool output without invoking an LLM",
        source: "builtin",
        kind: "action",
      },
    ])
  })

  test("preserves legacy command objects and lets them shadow builtins", () => {
    const result = CommandCatalog.list([legacy])

    expect(result[0]).toBe(legacy)
    expect(result.find((item) => item.name === "shake" && item.source === "builtin")).toBeUndefined()
  })

  test("adds an action builtin without changing legacy command objects", () => {
    const command = { ...legacy, name: "custom" }
    const result = CommandCatalog.list([command])
    const builtin = result.find((item) => item.name === "shake")

    expect(result[0]).toBe(command)
    expect(builtin).toEqual({
      name: "shake",
      description: "clear eligible tool output without invoking an LLM",
      source: "builtin",
      kind: "action",
    })
  })
})
