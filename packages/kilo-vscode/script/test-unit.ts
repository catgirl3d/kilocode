#!/usr/bin/env bun
// fork_change - new file

// Runs the unit suite and ends the output with a list of what failed.
// Bun prints each failure when it happens, so in a long --dots run with noisy test logs
// failures end up in the middle of the output and get lost. The full log and a failure
// report are kept in test-results/ so a failed run never has to be repeated just to see it.
//
// Positional args replace tests/unit/ (e.g. `bun run test:unit ./tests/unit/a.test.ts`);
// flags are passed to `bun test` as-is. Give flag values with `=` except for `-t`.

import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const dir = path.join(root, "test-results")
const xml = path.join(dir, "unit-junit.xml")
const log = path.join(dir, "unit.log")
const report = path.join(dir, "unit-failures.txt")
const limit = 30

const args = process.argv.slice(2)
const paths = args.filter(
  (arg, i) => !arg.startsWith("-") && !["-t", "--test-name-pattern"].includes(args[i - 1] ?? ""),
)

mkdirSync(dir, { recursive: true })
rmSync(xml, { force: true })
rmSync(report, { force: true })
rmSync(log, { force: true })

const cmd = [
  process.execPath,
  "test",
  ...(paths.length > 0 ? [] : ["tests/unit/"]),
  "--dots",
  "--timeout=30000",
  "--parallel=5",
  "--timings=node_modules/.cache/bun-test-timings.json",
  "--update-timings",
  "--path-ignore-patterns=**/i18n-unused-keys.test.ts",
  "--path-ignore-patterns=**/i18n-keys.test.ts",
  "--reporter=junit",
  `--reporter-outfile=${xml}`,
  ...args,
]

const ansi = /\x1b\[[0-9;]*[A-Za-z]/g
const sink = Bun.file(log).writer()
const proc = Bun.spawn(cmd, {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, ...(process.stderr.isTTY ? { FORCE_COLOR: "1" } : {}) },
})
const pump = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
  for await (const chunk of stream) {
    target.write(chunk)
    sink.write(chunk)
  }
}
await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)])
const code = await proc.exited
await sink.end()

const text = (await Bun.file(log).text()).replace(ansi, "")
await Bun.write(log, text)
const lines = text.split(/\r?\n/)
const count = (word: string) => Number([...text.matchAll(new RegExp(`^\\s*(\\d+) ${word}$`, "gm"))].at(-1)?.[1] ?? 0)
const fails = count("fail")
const errs = count("errors?")

const entities: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" }
const unescape = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, entity: string) => {
    if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)))
    return entities[entity] ?? all
  })
const attrs = (value: string) =>
  Object.fromEntries([...value.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], unescape(m[2] ?? "")]))
const normalize = (file: string) => file.replaceAll("\\", "/")
const first = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? ""

type Failure = { file: string; where: string; title: string; message: string; detail: string }

// Test failures come from the junit report: it has file, line and the full error.
const junit = await Bun.file(xml)
  .text()
  .catch(() => undefined)
const tests: Failure[] = [
  ...(junit ?? "").matchAll(
    /<testcase((?:\s+[\w:-]+="[^"]*")*)\s*>\s*<(failure|error)((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\2>)/g,
  ),
].map((m) => {
  const test = attrs(m[1] ?? "")
  const err = attrs(m[3] ?? "")
  const detail = unescape(m[4] ?? err.message ?? "")
  const file = normalize(test.file ?? "")
  return {
    file,
    where: test.line ? `${file}:${test.line}` : file,
    // classname lists describe blocks innermost first.
    title: [...(test.classname ?? "").split(" > ").reverse(), test.name].filter(Boolean).join(" > "),
    message: first(err.message ?? detail),
    detail,
  }
})

// Errors outside tests (a file that fails to import, a throw after the last test) never reach
// the junit report, and without it (bun crashed or every file failed to load) the `(fail)`
// lines in the log are the only record of failed tests.
const errors: Failure[] = []
const logged: Failure[] = []
let file = ""
for (let i = 0; i < lines.length; i++) {
  const line = lines[i] ?? ""
  const head = line.match(/^(\S.*\.(?:test|spec)\.[cm]?[jt]sx?):$/)
  if (head) {
    file = normalize(head[1] ?? "")
    continue
  }
  // `✗` instead of `(fail)` when colors are on.
  const fail = line.match(/^(?:\(fail\)|✗) (.*?)(?: \[[\d.]+m?s\])?$/)
  if (fail) {
    logged.push({ file, where: file, title: fail[1] ?? "", message: "", detail: "" })
    continue
  }
  if (line.trim() !== "# Unhandled error between tests") continue
  const start = i + 2
  const stop = lines.findIndex((next, j) => j >= start && /^-{10,}$/.test(next.trim()))
  const block = lines.slice(start, stop === -1 ? undefined : stop).join("\n")
  errors.push({
    file,
    where: file || "(unknown file)",
    title: "error outside tests",
    message: first(block.match(/^error: .*$/m)?.[0] ?? block),
    detail: block,
  })
  if (stop !== -1) i = stop
}

const failures = [...(junit == null ? logged : tests), ...errors]
const files = [...new Set(failures.map((item) => item.file).filter(Boolean))]
const rerun =
  files.length > 0
    ? `bun run test:unit ${files.map((item) => (path.isAbsolute(item) ? item : `./${item}`)).join(" ")}`
    : ""
const notes = [
  junit == null && code !== 0
    ? `junit report missing: errors are taken from the log, check ${normalize(path.relative(root, log))}`
    : "",
  failures.length < fails || errors.length < errs
    ? `listed ${failures.length} of ${fails} fail / ${errs} error: the rest is only in ${normalize(path.relative(root, log))}`
    : "",
  code !== 0 && failures.length === 0 ? `bun test exited with code ${code} without reporting a failing test` : "",
].filter(Boolean)
const stamp = `${new Date().toISOString()}, run: ${args.join(" ") || "tests/unit/"}`

if (code === 0) {
  await Bun.write(report, `No failures (${stamp})\n`)
  process.exit(0)
}

await Bun.write(
  report,
  [
    `bun test exited with code ${code}: ${fails} fail, ${errs} error (${stamp})`,
    ...notes,
    rerun ? `Rerun: ${rerun}` : "",
    ...failures.map((item) => `\n=== ${item.where} — ${item.title}\n${item.detail || item.message}`),
  ]
    .filter(Boolean)
    .join("\n") + "\n",
)

const bar = "=".repeat(70)
console.log(
  [
    "",
    bar,
    `FAILED: ${fails} fail, ${errs} error (exit code ${code})`,
    ...failures
      .slice(0, limit)
      .map((item) => `  ${item.where} — ${item.title}${item.message ? `\n      ${item.message}` : ""}`),
    failures.length > limit ? `  … ${failures.length - limit} more in the report` : "",
    ...notes.map((note) => `! ${note}`),
    rerun ? `Rerun only these: ${rerun}` : "",
    `Details: ${normalize(path.relative(root, report))}   Full log: ${normalize(path.relative(root, log))}`,
    bar,
  ]
    .filter(Boolean)
    .join("\n"),
)
process.exit(code)
