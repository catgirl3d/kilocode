// Read-only checker for the redaction corpus. It reports disagreements; it never rewrites a case.
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

type TextCase = { id: string; input: string; expected: string }
type WriteCase = { id: string; old: string; next: string; expected: boolean }

const root = path.dirname(fileURLToPath(import.meta.url))
const values = { values: true } as const

const text: TextCase[] = (await Bun.file(path.join(root, "text-cases.json")).json()).cases
const write: WriteCase[] = (await Bun.file(path.join(root, "write-cases.json")).json()).cases
const clean = path.join(root, "clean")
const files = readdirSync(clean).map((name) => path.join(clean, name))

let failed = 0
let checked = 0

for (const item of text) {
  checked++
  const got = MemoryRedact.text(item.input, values)
  if (got === item.expected) continue
  failed++
  console.log(
    `FAIL text ${item.id}\n  input:    ${JSON.stringify(item.input)}\n  expected: ${JSON.stringify(item.expected)}\n  got:      ${JSON.stringify(got)}`,
  )
}

for (const item of write) {
  checked++
  const got = MemoryRedact.blocksWrite(item.old, item.next)
  if (got === item.expected) continue
  failed++
  console.log(`FAIL write ${item.id}\n  expected: ${item.expected}\n  got:      ${got}`)
}

for (const file of files) {
  checked++
  const input = await Bun.file(file).text()
  const got = MemoryRedact.text(input, values)
  if (got === input) continue
  failed++
  console.log(`FAIL clean ${path.basename(file)} changed by values mode`)
}

console.log(`\n${checked - failed}/${checked} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
