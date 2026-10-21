import { expect, it } from "bun:test"
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

const itemsAnchor = `      return source.filter((item) => item.tagIds.some((id) => active.has(id)))
    },
    undefined,
    { equals: same },`

const itemsNoEquals = `      return source.filter((item) => item.tagIds.some((id) => active.has(id)))
    },
    undefined,`

const filterAnchor = `      return state.tags.filter((tag) => ids.has(tag.id))
    },
    undefined,
    { equals: same },`

const filterNoEquals = `      return state.tags.filter((tag) => ids.has(tag.id))
    },
    undefined,`

const fieldAnchor = `  const field = (x: unknown, y: unknown) =>
    Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => v === y[i]) : Object.is(x, y)`

const fieldReplace = `  const field = (x: unknown, y: unknown) => Object.is(x, y)`

const batchAnchor = `                batch(() => {
                  for (const item of chosen()) session.deleteSession(item.id)
                })`

const batchReplace = `                for (const item of chosen()) session.deleteSession(item.id)`

const keysAnchor = `    const keys = Object.keys(x) as (keyof T)[]
    return keys.length === Object.keys(y).length && keys.every((key) => field(x[key], y[key]))`

const itemsBypass = (
  condition: string,
) => `      return source.filter((item) => item.tagIds.some((id) => active.has(id)))
    },
    undefined,
    { equals: (a, b) => (${condition} ? false : same(a, b)) },`

const ignore = (name: string) => `    const keys = (Object.keys(x) as (keyof T)[]).filter((key) => key !== "${name}")
    return (
      keys.length === (Object.keys(y) as (keyof T)[]).filter((key) => key !== "${name}").length &&
      keys.every((key) => field(x[key], y[key]))
    )`

function mutant(
  id: string,
  anchor: string,
  replace: string,
  fixtures: string[],
  assertions: Record<string, string> = {},
): Case {
  return { id, anchor, replace, fixtures, assertions }
}

const cases: Case[] = [
  mutant("items-equals-removed", itemsAnchor, itemsNoEquals, ["session-list-hover-refresh"], {
    "session-list-hover-refresh": "a refresh with equal session data keeps the rendered row",
  }),
  mutant("filter-tags-equals-removed", filterAnchor, filterNoEquals, ["session-list-hover-refresh"], {
    "session-list-hover-refresh": "an equal tag catalog keeps the filter chip",
  }),
  mutant("array-field-reference-equality", fieldAnchor, fieldReplace, ["session-list-hover-refresh"], {
    "session-list-hover-refresh": "a refresh with equal session data keeps the rendered row",
  }),
  mutant("bulk-batch-removed", batchAnchor, batchReplace, ["session-list-selection"], {
    "session-list-selection":
      "the bulk confirmation never exposes a partial chosen-session removal to reactive consumers",
  }),
  mutant(
    "items-equals-scoped-bypass",
    itemsAnchor,
    itemsBypass("props.sessionIds?.() !== undefined"),
    ["session-history-regressions"],
    {
      "session-history-regressions": "an equal scoped session refresh keeps the exact favorite row",
    },
  ),
  mutant(
    "items-equals-active-tags-bypass",
    itemsAnchor,
    itemsBypass("activeTags().size > 0"),
    ["session-history-regressions", "session-tags-ui"],
    {
      "session-history-regressions": "an equal refresh under an active tag filter keeps the exact row",
      "session-tags-ui": "an active tag filter keeps the exact matching row node across an equal session refresh",
    },
  ),
  mutant("filter-tags-color-ignored", keysAnchor, ignore("color"), ["session-tags-ui"], {
    "session-tags-ui": "a color-only tag snapshot updates the filter chip color",
  }),
  mutant("items-title-ignored", keysAnchor, ignore("title"), ["session-list-hover-refresh", "session-tags-ui"], {
    "session-list-hover-refresh": "a title-only refresh renders the new title",
    "session-tags-ui": "a title-only session refresh renders the new title",
  }),
  mutant("items-favorite-ignored", keysAnchor, ignore("favorite"), ["session-tags-ui"], {
    "session-tags-ui": "the favorites group is rendered first",
  }),
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

if (process.env.KILO_SESSION_LIST_MUTATION === "1") {
  it("mutation baseline", async () => {
    for (const name of names) await fixture(name)
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
