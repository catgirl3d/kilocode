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

const file = path.resolve(import.meta.dir, "../../../kilo-ui/src/components/message-part.tsx")
const scenario = "native-tool-render"

const openBlock = `        <Show when={open()}>
          <Tooltip value={i18n.t("ui.messagePart.openInEditor")} placement="top" gutter={4}>
            <IconButton
              icon="go-to-file"
              size="small"
              variant="ghost"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                data.openFile!(props.file!, undefined, undefined, props.session)
              }}
              aria-label={i18n.t("ui.messagePart.openInEditor")}
            />
          </Tooltip>
        </Show>`

const diffBlock = `        <Show when={props.when}>
          <Tooltip value={i18n.t("ui.messagePart.openInDiffViewer")} placement="top" gutter={4}>
            <IconButton
              icon="square-arrow-top-right"
              size="small"
              variant="ghost"
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onClick}
              aria-label={i18n.t("ui.messagePart.openInDiffViewer")}
            />
          </Tooltip>
        </Show>`

// The call-site anchors span the source's marker comment; building it keeps marker text out of this test file.
const block = `${["fork", "change"].join("_")} start`

const editHead = `<ToolFileMeta filePath={props.input.filePath} changes={props.metadata.filediff ?? streamed()} />
                </div>
              </div>
              {/* ${block} */}
              <ToolDiffAction
                when={canOpenDiff()}
                onClick={handleOpenDiffClick}
`

const writeHead = `                  />
                </div>
              </div>
              {/* ${block} */}
              <ToolDiffAction
                when={canOpenDiff()}
                onClick={handleOpenDiffClick}
`

const editFile = `${editHead}                file={props.status === "completed" ? props.input.filePath : undefined}`
const writeFile = `${writeHead}                file={props.status === "completed" ? props.input.filePath : undefined}`
const editPlain = `${editHead}                file={props.input.filePath}`
const writePlain = `${writeHead}                file={props.input.filePath}`
const openCall = "data.openFile!(props.file!, undefined, undefined, props.session)"

function mutant(id: string, anchor: string, replace: string, message: string): Case {
  return { id, anchor, replace, file, fixtures: [scenario], assertions: { [scenario]: message } }
}

const cases: Case[] = [
  mutant(
    "open-never-shown",
    "  const open = () => !!props.file && !!data.openFile",
    "  const open = () => false",
    "write shows Open in Editor before Open in Diff Viewer",
  ),
  mutant(
    "open-gate-ignores-file",
    "  const open = () => !!props.file && !!data.openFile",
    "  const open = () => !!data.openFile",
    "a running write offers no editor action",
  ),
  mutant("write-status-gate-removed", writeFile, writePlain, "a running write offers no editor action"),
  mutant("edit-status-gate-removed", editFile, editPlain, "a running edit offers no editor action"),
  mutant(
    "write-session-removed",
    `${writeFile}\n                session={props.sessionID}`,
    writeFile,
    "write scopes the editor open to its session",
  ),
  mutant(
    "edit-session-removed",
    `${editFile}\n                session={props.sessionID}`,
    editFile,
    "edit scopes the editor open to its session",
  ),
  mutant(
    "open-without-session",
    openCall,
    "data.openFile!(props.file!, undefined, undefined)",
    "write scopes the editor open to its session",
  ),
  mutant(
    "open-stop-propagation-removed",
    `              onClick={(e) => {\n                e.stopPropagation()\n                ${openCall}`,
    `              onClick={(e) => {\n                ${openCall}`,
    "write editor action leaves the tool card collapsed",
  ),
  mutant(
    "outer-show-when-only",
    "    <Show when={props.when || open()}>",
    "    <Show when={props.when}>",
    "a write without a diff offers only the editor action",
  ),
  mutant(
    "diff-show-always",
    `        <Show when={props.when}>\n          <Tooltip value={i18n.t("ui.messagePart.openInDiffViewer")}`,
    `        <Show when={true}>\n          <Tooltip value={i18n.t("ui.messagePart.openInDiffViewer")}`,
    "a write without a diff offers only the editor action",
  ),
  mutant(
    "buttons-swapped",
    `      <span data-slot="tool-trigger-actions">\n${openBlock}\n${diffBlock}\n      </span>`,
    `      <span data-slot="tool-trigger-actions">\n${diffBlock}\n${openBlock}\n      </span>`,
    "write shows Open in Editor before Open in Diff Viewer",
  ),
  mutant("open-calls-diff-handler", openCall, "props.onClick(e)", "write opens its file in the editor"),
  mutant(
    "open-wrong-file",
    openCall,
    'data.openFile!("/project/elsewhere.txt", undefined, undefined, props.session)',
    "write opens its file in the editor",
  ),
  mutant(
    "open-label-swapped",
    `              aria-label={i18n.t("ui.messagePart.openInEditor")}\n            />\n          </Tooltip>\n        </Show>\n        <Show when={props.when}>`,
    `              aria-label={i18n.t("ui.messagePart.openInDiffViewer")}\n            />\n          </Tooltip>\n        </Show>\n        <Show when={props.when}>`,
    "write shows Open in Editor before Open in Diff Viewer",
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

if (process.env.KILO_TOOL_OPEN_MUTATION === "1") {
  it("mutation baseline", async () => {
    for (const name of names) await fixture(name)
  }, 110_000)
  it("mutation classifier", () => {
    const excerpt = [
      '  120 | assert.ok(open && show, "write shows Open in Editor before Open in Diff Viewer")',
      "AssertionError: a different assertion",
      'code: "ERR_ASSERTION"',
    ].join("\n")
    const table = [
      { name: "exit zero", code: 0, output: "", expected: "message", want: "survived" },
      {
        name: "message in source excerpt only",
        code: 1,
        output: excerpt,
        expected: "write shows Open in Editor before Open in Diff Viewer",
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
