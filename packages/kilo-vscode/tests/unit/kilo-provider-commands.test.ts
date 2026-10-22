import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { loadCommands } from "../../src/kilo-provider/commands"

const client = (data: unknown[]) =>
  ({
    command: { list: async () => ({ data }) },
  }) as unknown as KiloClient

describe("loadCommands", () => {
  it("drops null overrides the CLI emits for unset workflow fields", async () => {
    const message = (await loadCommands(
      client([
        {
          name: "review_c",
          description: "Workflow: review_c",
          agent: null,
          model: null,
          variant: null,
          source: "command",
          subtask: null,
          hints: [],
        },
      ]),
      "/null-overrides",
    )) as { commands: Record<string, unknown>[] }

    const cmd = message.commands[0]!
    expect(cmd.agent).toBeUndefined()
    expect(cmd.model).toBeUndefined()
    expect(cmd.variant).toBeUndefined()
  })

  it("keeps assigned overrides, including an explicit Default variant", async () => {
    const message = (await loadCommands(
      client([
        { name: "assigned", agent: "ask", model: "kilo/model", variant: "high", hints: [] },
        { name: "default", variant: "", hints: [] },
      ]),
      "/assigned-overrides",
    )) as { commands: Record<string, unknown>[] }

    expect(message.commands[0]).toMatchObject({ agent: "ask", model: "kilo/model", variant: "high" })
    expect(message.commands[1]!.variant).toBe("")
  })
})
