import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as DirectAction from "../../../../src/kilocode/cli/cmd/run/direct-action"

describe("Kilo direct run actions", () => {
  test("matches only the builtin shake command", () => {
    expect(DirectAction.matches({ name: "shake", source: "builtin" })).toBe(true)
    expect(DirectAction.matches({ name: "shake" })).toBe(false)
    expect(DirectAction.matches({ name: "shake", source: "command" as never })).toBe(false)
    expect(DirectAction.matches({ name: "compact", source: "builtin" })).toBe(false)
  })

  test("calls shake and appends its completion footer", async () => {
    const commits: unknown[] = []
    const traces: unknown[] = []
    const client = {
      session: {
        shake: async () => ({ data: { parts: 3, tokens: 42 } }),
      },
    }

    await Effect.runPromise(
      DirectAction.run({
        sdk: client as never,
        sessionID: "ses_test",
        directory: "/tmp/project",
        signal: new AbortController().signal,
        footer: { append: (commit: unknown) => commits.push(commit) } as never,
        trace: { write: (...entry: unknown[]) => traces.push(entry) },
      }),
    )

    expect(commits).toEqual([
      expect.objectContaining({
        kind: "system",
        text: "shake: cleared 3 tool outputs (~42 tokens)",
      }),
    ])
    expect(traces).toContainEqual([
      "send.shake.ok",
      { sessionID: "ses_test", result: { parts: 3, tokens: 42 } },
    ])
  })

  test("does not append completion output when the endpoint fails", async () => {
    const commits: unknown[] = []
    const client = {
      session: {
        shake: async () => {
          throw new Error("shake failed")
        },
      },
    }

    await expect(
      Effect.runPromise(
        DirectAction.run({
          sdk: client as never,
          sessionID: "ses_test",
          signal: new AbortController().signal,
          footer: { append: (commit: unknown) => commits.push(commit) } as never,
        }),
      ),
    ).rejects.toThrow("shake failed")
    expect(commits).toHaveLength(0)
  })
})
