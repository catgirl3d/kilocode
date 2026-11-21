import { describe, expect, test } from "bun:test"
import { MemoryRedact } from "../src/capture/redact"

describe("pgpass redaction", () => {
  const values = { values: true }
  const marker = "[redacted]"
  const colon = String.fromCharCode(58)
  const pass = ["fixture", "only"].join("-")

  test("leaves prefixed code lines and relative paths unchanged", () => {
    const unchanged = [
      [
        ["packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts", "452", ""].join(colon),
        "  public handleMessage(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {",
      ],
      [
        ["packages/kilo-vscode/src/agent-manager/pr-status-bridge.ts", "150", ""].join(colon),
        "  handleMessage(m: Record<string, unknown>): boolean {",
      ],
      [
        ["packages/kilo-vscode/webview-ui/src/context/session-queue.ts", "241", ""].join(colon),
        "  function serverQueue(ids: string[], messages: Message[], status: SessionStatusInfo, submitting?: boolean) {",
      ],
      [
        ["packages/kilo-vscode/webview-ui/src/components/chat/MessageList.tsx", "225", ""].join(colon),
        "  function buildPattern(query: string, matchCase: boolean, wholeWord: boolean, regex: boolean): RegExp | undefined {",
      ],
      [
        ["packages/kilo-vscode/src/agent-manager/pr-status-bridge.ts", "31", ""].join(colon),
        "  updateWorktreePR(id: string, number?: number, url?: string, state?: string): void",
      ],
      [
        ["packages/kilo-vscode/src/diff/sources/staged.ts", "57", ""].join(colon),
        '  const output = opts.git ? undefined : vscode.window.createOutputChannel("Kilo Diff: Staged")',
      ],
      [
        ["packages/kilo-vscode/src/diff/sources/unstaged.ts", "63", ""].join(colon),
        '  const output = opts.git ? undefined : vscode.window.createOutputChannel("Kilo Diff: Unstaged")',
      ],
      [
        ["packages/kilo-vscode/src/diff/sources/worktree.ts", "59", ""].join(colon),
        '  const output = opts.git ? undefined : vscode.window.createOutputChannel("Kilo Diff: Workspace")',
      ],
    ] as const

    for (const [prefix, body] of unchanged) {
      const input = prefix + body
      expect(MemoryRedact.text(input, values), input).toBe(input)
    }

    const relative = ["fixture-only\\pg.test", "5432", "app", "alice", pass].join(colon)
    expect(MemoryRedact.text(relative, values), relative).toBe(relative)
  })

  test("keeps passfile rows masked after relative prefixes and prior redaction", () => {
    const full = [
      ["fixture-only/logs/out.txt", "7"].join(colon),
      ["db.example", "5432", "app", "alice", pass].join(colon),
    ].join(colon)
    const fullExpected = ["fixture-only/logs/out.txt", "7", "db.example", "5432", marker].join(colon)
    expect(MemoryRedact.text(full, values), full).toBe(fullExpected)

    const code = [
      ["fixture-only/send.ts", "5"].join(colon),
      ["function send(row", " Record<string, string>)", " void { db.example", "5432", "app", "alice", pass].join(colon),
    ].join(colon)
    const codeExpected = ["fixture-only/send.ts", "5", "function send(row", " Record<string, string>)", marker].join(
      colon,
    )
    expect(MemoryRedact.text(code, values), code).toBe(codeExpected)

    const curl = ["fixture-only/logs/out.txt", "7", "x", "y", " -u db.example", "app", "blue alice smith", pass].join(
      colon,
    )
    const curlExpected = ["fixture-only/logs/out.txt", "7", "x", "y", marker].join(colon)
    expect(MemoryRedact.text(curl, values), curl).toBe(curlExpected)

    const diagnostic = ["fixture-only/db.test", "5432", "app", "alice", pass + " (tags:x:y)"].join(colon)
    const diagnosticExpected = ["fixture-only/db.test", "5432", "app", "alice", marker].join(colon)
    expect(MemoryRedact.text(diagnostic, values), diagnostic).toBe(diagnosticExpected)
  })

  test("keeps complete passfile rows masked, including socket hosts", () => {
    const rows = [
      ["db.test", "5432", "app", "alice", ""],
      ["192.168.1.10", "5432", "app", "alice", ""],
      ["localhost", "5432", "app", "alice", ""],
      ["@/tmp/pg.test", "5432", "app", "alice", ""],
      ["/tmp/pg.test", "5432", "app", "alice", ""],
      ['"/tmp/pg.test', "5432", "app", "alice", '"'],
    ] as const

    for (const [host, port, db, user, end] of rows) {
      const input = [host, port, db, user, pass].join(colon) + end
      const expected = [host, port, db, user, marker].join(colon) + end
      expect(MemoryRedact.text(input, values), input).toBe(expected)
    }

    const host = ["fixture-only/.pgpass", "1", "*"].join(colon)
    const input = [host, "*", "db", "user", pass].join(colon)
    const expected = [host, "*", marker].join(colon)
    expect(MemoryRedact.text(input, values), input).toBe(expected)
  })
})
