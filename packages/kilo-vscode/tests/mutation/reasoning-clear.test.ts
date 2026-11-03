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

const state = path.resolve(import.meta.dir, "../../webview-ui/src/context/session-reasoning.ts")
const dialog = path.resolve(import.meta.dir, "../../webview-ui/src/components/chat/ClearReasoningDialog.tsx")
const scenario = "task-header-actions-regression"

function mutant(id: string, file: string, anchor: string, replace: string, message: string): Case {
  return { id, file, anchor, replace, fixtures: [scenario], assertions: { [scenario]: message } }
}

const cases: Case[] = [
  mutant(
    "preview-post-drops-flag",
    state,
    `deps.post({ type: "sessionReasoningClearPreview", sessionID, requestID, keepTurns, includeCarriers })`,
    `deps.post({ type: "sessionReasoningClearPreview", sessionID, requestID, keepTurns, includeCarriers: false })`,
    "the carrier option is forwarded to the preview",
  ),
  mutant(
    "apply-post-drops-flag",
    state,
    `deps.post({ type: "sessionReasoningClear", sessionID, requestID, keepTurns, token, includeCarriers })`,
    `deps.post({ type: "sessionReasoningClear", sessionID, requestID, keepTurns, token, includeCarriers: false })`,
    "apply forwards the carrier option",
  ),
  mutant(
    "preview-message-drops-candidates",
    state,
    "carrierCandidates: message.carrierCandidates ?? 0,",
    "carrierCandidates: 0,",
    "mixed carrier and unsupported state renders both statuses",
  ),
  mutant(
    "preview-stale-ignores-flag",
    state,
    "return preview.keepTurns !== keepTurns || (preview.includeCarriers ?? false) !== includeCarriers",
    "return preview.keepTurns !== keepTurns",
    "apply with a different carrier flag is rejected before the host",
  ),
  mutant(
    "carrier-checkbox-uses-unsupported",
    dialog,
    "return !!item && item.carrierCandidates > 0",
    "return !!item && (item.carrierCandidates > 0 || item.unsupported > 0)",
    "unsupported non-carrier state does not expose the carrier option",
  ),
  mutant(
    "preserved-never-shown",
    dialog,
    "return item && item.unsupported > 0 ? item : undefined",
    "return undefined",
    "a preview with unsupported parts renders the preserved status",
  ),
  mutant(
    "preserved-carriers-not-gated",
    dialog,
    "return item && !includeCarriers() && item.carrierCandidates > 0 ? item : undefined",
    "return item && item.carrierCandidates > 0 ? item : undefined",
    "included carriers still report unsupported state",
  ),
  mutant(
    "empty-ignores-unsupported",
    dialog,
    "return !!item && item.parts === 0 && item.turns === 0 && item.carrierCandidates === 0 && item.unsupported === 0",
    "return !!item && item.parts === 0 && item.turns === 0 && item.carrierCandidates === 0",
    "unsupported-only zero-target previews do not also claim there is nothing to clear",
  ),
  mutant(
    "no-targets-always-false",
    dialog,
    `  const noTargets = () => {
    const item = shown()
    return !!item && item.parts === 0 && item.turns === 0
  }`,
    "  const noTargets = () => false",
    "empty previews cannot apply",
  ),
  mutant(
    "toggle-does-not-preview",
    dialog,
    "session.reasoningPreview(props.sessionID, next, { includeCarriers: checked })",
    "undefined",
    "the carrier option is forwarded to the preview",
  ),
  mutant(
    "toggle-sends-wrong-flag",
    dialog,
    "session.reasoningPreview(props.sessionID, next, { includeCarriers: checked })",
    "session.reasoningPreview(props.sessionID, next, { includeCarriers: false })",
    "the carrier option is forwarded to the preview",
  ),
]

const names = [...new Set(cases.flatMap((item) => item.fixtures))]

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

async function run(item: Case, name: string): Promise<Outcome> {
  try {
    const result = await execute(name, item)
    const assertion = item.assertions[name]
    const status = judge(result.code, result.output, assertion)
    if (status === "killed") return { fixture: name, status, detail: assertion! }
    if (status === "survived") return { fixture: name, status, detail: result.file }
    return { fixture: name, status, detail: `exit ${result.code}: ${first(result.output)}` }
  } catch (error) {
    return {
      fixture: name,
      status: "invalid",
      detail: `build: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function register(item: Case) {
  it(`mutation ${item.id}`, async () => {
    const results: Outcome[] = []
    for (const name of item.fixtures) {
      const result = await run(item, name)
      results.push(result)
      console.log(`[mutation] ${item.id} @ ${name}: ${result.status} (${result.detail})`)
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

if (process.env.KILO_REASONING_CLEAR_MUTATION === "1") {
  it("mutation baseline", async () => {
    for (const name of names) await fixture(name)
  }, 110_000)
  it("mutation classifier", () => {
    const excerpt = [
      '  120 | assert.ok(open && show, "the carrier option is forwarded to the preview")',
      "AssertionError: a different assertion",
      'code: "ERR_ASSERTION"',
    ].join("\n")
    const table = [
      { name: "exit zero", code: 0, output: "", expected: "message", want: "survived" },
      {
        name: "message in source excerpt only",
        code: 1,
        output: excerpt,
        expected: "the carrier option is forwarded to the preview",
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
