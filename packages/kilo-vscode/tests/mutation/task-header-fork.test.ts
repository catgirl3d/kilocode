import { expect, it } from "bun:test"
import path from "node:path"
import { execute, fixture, type Mutation } from "../fixtures/run"

type Case = Mutation & {
  fixtures: string[]
  assertions: Record<string, string>
}

type Outcome = {
  fixture: string
  status: "killed" | "survived" | "invalid"
  detail: string
}

const header = path.resolve(import.meta.dir, "../../webview-ui/src/components/chat/TaskHeader.tsx")
const scenario = "task-header-fork"

function mutant(id: string, anchor: string, replace: string, message: string): Case {
  return { id, file: header, anchor, replace, fixtures: [scenario], assertions: { [scenario]: message } }
}

const cases: Case[] = [
  mutant(
    "fork-row-removed",
    "    ...(props.onFork",
    "    ...(false && props.onFork",
    "the local header exposes the translated Fork Session row",
  ),
  mutant(
    "fork-row-shown-without-handler",
    "    ...(props.onFork",
    "    ...(true",
    "a header without onFork has no Fork Session row",
  ),
  mutant(
    "fork-enabled-when-busy",
    "            disabled: !canFork(),",
    "            disabled: false,",
    "busy-header header disables the Fork Session row",
  ),
  mutant(
    "fork-allows-non-idle",
    '  const canFork = createMemo(() => session.status() === "idle" && !!sid())',
    "  const canFork = createMemo(() => !!sid())",
    "busy-header header disables the Fork Session row",
  ),
  mutant(
    "fork-allows-cloud-and-draft",
    '  const canFork = createMemo(() => session.status() === "idle" && !!sid())',
    '  const canFork = createMemo(() => session.status() === "idle")',
    "cloud-header header disables the Fork Session row",
  ),
  mutant(
    "fork-wrong-session-id",
    "              if (id) props.onFork?.(id)",
    '              if (id) props.onFork?.("wrong-session")',
    "selecting Fork Session passes the current session id once",
  ),
]

function judge(code: number, output: string, expected: string | undefined) {
  if (code === 0) return "survived"
  if (code !== 1 || expected === undefined) return "invalid"
  const line = output.match(/^AssertionError(?: \[ERR_ASSERTION\])?: ([^\r\n]*)/m)
  return line?.[1]?.trimEnd() === expected ? "killed" : "invalid"
}

function first(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  )
}

async function run(item: Case, fixture: string): Promise<Outcome> {
  try {
    const result = await execute(fixture, item)
    const assertion = item.assertions[fixture]
    const status = judge(result.code, result.output, assertion)
    if (status === "killed") return { fixture, status, detail: assertion! }
    if (status === "survived") return { fixture, status, detail: result.file }
    return { fixture, status, detail: `exit ${result.code}: ${first(result.output)}` }
  } catch (error) {
    return { fixture, status: "invalid", detail: `build: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function register(item: Case) {
  it(`mutation ${item.id}`, async () => {
    const results: Outcome[] = []
    for (const fixture of item.fixtures) {
      const result = await run(item, fixture)
      results.push(result)
      console.log(`[mutation] ${item.id} @ ${fixture}: ${result.status} (${result.detail})`)
    }
    console.log(`[mutation] ${item.id}: ${results.map((result) => `${result.fixture}=${result.status}`).join(", ")}`)
    const invalid = results.filter((result) => result.status === "invalid")
    if (invalid.length > 0) {
      throw new Error(
        `INVALID ${item.id}: ${invalid.map((result) => `${result.fixture}: ${result.detail}`).join("; ")}`,
      )
    }
    const missed = results.filter(
      (result) => item.assertions[result.fixture] !== undefined && result.status !== "killed",
    )
    if (missed.length > 0) {
      throw new Error(`SURVIVED ${item.id}: ${missed.map((result) => `${result.fixture}=${result.status}`).join(", ")}`)
    }
  }, 110_000)
}

if (process.env.KILO_TASK_HEADER_FORK_MUTATION === "1") {
  it("mutation baseline", async () => {
    await fixture(scenario)
  }, 110_000)
  it("mutation classifier", () => {
    const excerpt = [
      '  171 | assert.equal(item("ses-three"), favoriteThree, "a favorite-only refresh rerenders the changed row")',
      "AssertionError: a different assertion",
      'code: "ERR_ASSERTION"',
    ].join("\n")
    const table = [
      { name: "exit zero", code: 0, output: "", expected: "message", want: "survived" },
      {
        name: "message in source excerpt only",
        code: 1,
        output: excerpt,
        expected: "a favorite-only refresh rerenders the changed row",
        want: "invalid",
      },
      {
        name: "exact bun header",
        code: 1,
        output: 'AssertionError: message\ncode: "ERR_ASSERTION"',
        expected: "message",
        want: "killed",
      },
      {
        name: "exact node header",
        code: 1,
        output: "AssertionError [ERR_ASSERTION]: message\nstack",
        expected: "message",
        want: "killed",
      },
      { name: "runtime error", code: 1, output: "Error: boom", expected: "message", want: "invalid" },
      {
        name: "longer actual message",
        code: 1,
        output: "AssertionError: message plus more",
        expected: "message",
        want: "invalid",
      },
    ]
    for (const item of table) {
      expect(judge(item.code, item.output, item.expected), item.name).toBe(item.want)
    }
  })
  for (const item of cases) register(item)
}
