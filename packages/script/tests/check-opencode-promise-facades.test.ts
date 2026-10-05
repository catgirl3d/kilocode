import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const script = path.join(root, "script", "check-opencode-promise-facades.ts")
const src = path.join(root, "packages", "opencode", "src")

function run(opts: { duplicate?: boolean; sentinel?: boolean } = {}) {
  const code = `
const scan = Bun.Glob.prototype.scanSync
const src = ${JSON.stringify(src)}
Bun.Glob.prototype.scanSync = function* (opts) {
  for (const file of scan.call(this, opts)) {
    const rel = file.replaceAll("\\\\", "/")
    const win = rel.replaceAll("/", "\\\\")
    yield win
    if (${opts.duplicate === true} && opts.cwd === src && rel === "bus/index.ts") yield win
  }
  if (${opts.sentinel === true} && opts.cwd === src) yield "kilocode\\\\sentinel.ts"
}
await import(${JSON.stringify(pathToFileURL(script).href)})
`
  return spawnSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8" })
}

function fail(out: ReturnType<typeof run>) {
  const text = out.stderr || out.stdout || "Facade guard failed"
  const lines = text.split(/\r?\n/)
  const summary = lines.filter((line) => /^(Found |Classified |Do not add|Yield services|Remove migrated)/.test(line))
  throw new Error((summary.length ? summary : lines.slice(0, 8)).join("\n"))
}

test("classifies source and test hits from Windows-style glob paths", () => {
  const out = run()
  if (out.status !== 0) fail(out)
  expect(out.stdout.trim()).toBe(
    "check-opencode-promise-facades: 6 classified runtime site(s), 172 classified test reference(s), no runtime drift found.",
  )
})

test("normalizes before skipping owned files and keeps runtime counts strict", () => {
  const skip = run({ sentinel: true })
  if (skip.status !== 0) fail(skip)

  const drift = run({ duplicate: true })
  expect(drift.status).toBe(1)
  expect(drift.stderr).toContain("expected 1 classified site, found 2")
})
