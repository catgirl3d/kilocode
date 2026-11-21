// End-to-end smoke for the outbound access-key filter: a real CLI process talks to a
// real HTTP endpoint, and the assertions read the captured wire bodies.
//
// The "disabled" case is the control: it sends the same synthetic key unchanged, so a
// passing redaction assertion cannot be satisfied by the harness or provider transform.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

// Synthetic only: matches the detector's shape, belongs to no provider.
const KEY = "test0123456789abcdef0123456789abc"
const MARK = "[redacted]"

function bodies(hits: ReadonlyArray<{ body: Record<string, unknown> }>) {
  return hits.map((hit) => JSON.stringify(hit.body)).join("\n")
}

describe("outbound access-key filter over the real CLI process", () => {
  cliIt.live(
    "redacts a key from the prompt in every request the process sends",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("done")

        const result = yield* opencode.run(`Store this value: API_KEY=${KEY}`, { timeoutMs: 120_000 })
        opencode.expectExit(result, 0)

        const raw = bodies(yield* llm.hits)
        expect(raw).toContain(MARK)
        expect(raw).not.toContain(KEY)
      }),
    60_000,
  )

  cliIt.live(
    "sends the same key unchanged when the filter is disabled",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("done")

        // The flag is a personal global setting, so it belongs in the global config file.
        const config = path.join(home, ".config", "kilo", "kilo.json")
        yield* Effect.promise(() => mkdir(path.dirname(config), { recursive: true }))
        yield* Effect.promise(() => writeFile(config, JSON.stringify({ experimental: { redact_secrets: false } })))

        const result = yield* opencode.run(`Store this value: API_KEY=${KEY}`, { timeoutMs: 120_000 })
        opencode.expectExit(result, 0)

        // Control: the key is really on the wire when the filter is off.
        expect(bodies(yield* llm.hits)).toContain(KEY)
      }),
    60_000,
  )

  cliIt.live(
    "redacts a key that only appears in a tool result",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "note.txt")
        yield* Effect.promise(() => writeFile(file, `API_KEY="${KEY}"\n`))
        yield* llm.tool("read", { filePath: file })
        yield* llm.text("done")

        const result = yield* opencode.run("Read the file and confirm.", {
          // The fixture file lives outside the child's project directory.
          permission: { read: "allow", external_directory: "allow" },
          timeoutMs: 120_000,
        })
        opencode.expectExit(result, 0)

        const hits = yield* llm.hits
        const raw = bodies(hits)
        // The first request cannot carry the key; the follow-up carries the tool result.
        expect(hits.length).toBeGreaterThanOrEqual(2)
        expect(raw).toContain(MARK)
        expect(raw).not.toContain(KEY)

        // Outbound-only: the file on disk keeps the original text.
        const disk = yield* Effect.promise(() => Bun.file(file).text())
        expect(disk).toContain(KEY)
      }),
    60_000,
  )
})
