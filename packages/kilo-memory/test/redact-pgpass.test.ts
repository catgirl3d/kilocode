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

    const diagnostic = ["fixture-only/db.test", "5432", "app", "alice", pass + " (tags:x:y)"].join(colon)
    expect(MemoryRedact.text(diagnostic, values), diagnostic).toBe(diagnostic)
  })

  test("leaves search lines with double colons unchanged", () => {
    const lines = [
      '.github/workflows/visual-regression.yml~167~          echo "~~error~~Please ask a developer for help updating the screenshots."',
      '.github/workflows/check.yml~12~      - run: echo "~~warning file=a.ts,line=3~~Something odd"',
      "src/main.rs~10~    let map = std~~collections~~HashMap~~new();",
      "src/main.rs~1~std~~io~~stdin().read_line(&mut line)",
      "src/main.rs~5~    x~ foo, y~ std~~io~~Result",
      "app/Models/User.php~44~        return Foo~~bar()~~baz;",
      'check.yml~167~ echo "~~plain"',
      'package.json~12~  "x"~ "a~~b~~c"',
      "/home/dev/app/src/main.rs~10~    let map = std~~collections~~HashMap~~new();",
      "logs/app.log~5~2026-11-24 12~30~45~ info~ started~ ok",
      "logs/app.log~5~mac 00~11~22~33~44~55 up",
      'src/check.ts~5~  expect(out).toBe("x~[redacted]") // a~~b',
    ]
    for (const line of lines) {
      const input = line.replaceAll("~", colon)
      expect(MemoryRedact.text(input, values), input).toBe(input)
    }
  })

  test("keeps passfile rows masked after search prefixes", () => {
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

    const prefixed = [
      ["logs/out.txt~3~ echo ~~db.example~5432~app~alice~", "logs/out.txt~3~ echo ~~"],
      ["/home/dev/notes.txt~3~db.example~5432~app~alice~", "/home/dev/notes.txt~3~db.example~5432~"],
      ["notes.txt~3~db.example~5432~app~alice~", "notes.txt~3~db.example~5432~"],
    ] as const
    for (const [row, prefix] of prefixed) {
      const input = row.replaceAll("~", colon) + pass
      expect(MemoryRedact.text(input, values), input).toBe(prefix.replaceAll("~", colon) + marker)
    }
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
