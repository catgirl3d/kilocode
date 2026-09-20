#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Read-only audit of this personal fork against Kilo Code. This checks fork
 * ownership and marker coverage; it is not a whole-repository marker linter
 * and it never writes markers.
 *
 * Comparison:
 * - The candidate base defaults to `upstream/main` and can be set with
 *   `--base=<ref>`.
 * - The resolved comparison base is `git merge-base HEAD <candidate>`.
 * - Committed mode audits `<merge-base>...HEAD`. `--worktree` audits the
 *   working tree against that resolved merge-base and includes untracked
 *   files; it does not distinguish the staged index from the worktree.
 * - Ownership comes from the normalized Git diff, not marker presence.
 *   Marker-only edits and diff-matched churn are not fork-owned changes.
 *
 * 🛡️ LAYER RULES:
 *   1. Kilo-Exclusive Layer (packages/kilo-vscode, packages/kilo-ui):
 *      - MUST use `// fork_change` (or `// fork_change - new file` on Line 1 of new files)
 *      - NEVER use `// kilocode_change` (forbidden by CI check-kilocode-change)
 *   2. Shared OpenCode Layer (packages/core, packages/tui, packages/opencode/src outside kilocode/):
 *      - MUST use `// kilocode_change` (or `// kilocode_change - new file` on Line 1 of new files)
 *      - Optional: use `// kilocode_change start - [fork] <reason>` to distinguish fork additions
 *      - NEVER use `// fork_change`
 *   3. Kilo Backend (packages/opencode/src/kilocode, packages/kilo-gateway, packages/kilo-memory):
 *      - Both `fork_change` and historical `kilocode_change` are permitted.
 *      - New files use `// fork_change - new file` (or `// kilocode_change - new file`).
 *   4. Tests (test/, tests/, *.test.ts, *.spec.ts) & Docs/Configs:
 *      - Completely exempt from all markers (no headers, no inner markers per AGENTS.md: Exempt Files).
 *
 * Findings:
 * - `[MISSING]`, redundant fork markers, `fork_change` diagnostics, and
 *   mixed-family diagnostics are fatal and exit 1.
 * - Kilo-only `kilocode_change` anomalies remain visible as `[WARNING]` and
 *   do not increment fatal findings.
 * - Equivalent structural anomalies already present at the resolved
 *   merge-base are suppressed by diagnostic matching. Do not edit historical
 *   upstream Kilo markers merely to silence these warnings.
 *
 * CLI:
 * - `bun run script/fork-audit.ts [--worktree] [--base=<ref>]
 *   [--overwrap-report] [--inline-report] [--fragment-report] [paths...]`
 * - `--help` and `-h` print usage. Retired `--fix` and `--dry-run` options
 *   (including assignment forms) are rejected. The audit never writes source
 *   files, the index, refs, or configuration.
 *
 * Out of contract:
 * - Deletions and rename destinations are not line-audited. Binary files,
 *   YAML folded/literal scalars, and any staged-index/worktree distinction
 *   are outside the ownership guarantee. Ignored docs, configs, tests, and
 *   unsupported file types are outside the audit scope.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(process.env.FORK_AUDIT_ROOT ?? path.join(import.meta.dir, ".."))
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh", ".bash", ".yml", ".yaml", ".toml"])
const FORK_NEW = /(?:\/\/|\{?\s*\/\*|#)\s*fork_change\s*-\s*new\s*file\b/
const KILO_NEW = /(?:\/\/|\{?\s*\/\*|#)\s*kilocode_change\s*-\s*new\s*file\b/
const ANY = /(?:\/\/|\{?\s*\/\*|#)\s*(?:fork_change|kilocode_change)\b/
const BLOCK = /\/\*+\s*(?:fork_change|kilocode_change)\b[^*]*\*\//g
const MAX_PREVIEW = 5

type MarkerFamily = "fork" | "kilo"
type MarkerEvent = { family: MarkerFamily; kind: "start" | "end" | "inline" | "whole_file"; index: number }
type Diagnostic = { message: string; families: MarkerFamily[] }
type MarkerStack = { line: number; families: MarkerFamily[] }

function markerName(family: MarkerFamily): string {
  return family === "kilo" ? "kilocode_change" : "fork_change"
}

function markerNames(families: readonly MarkerFamily[]): string {
  return [...new Set(families)].map(markerName).join(", ")
}

export type FileZone = "kilo_exclusive" | "shared_opencode" | "kilo_backend"
export type MarkerBlock = {
  type: "inline" | "block" | "whole_file"
  startLine: number
  endLine: number
  markerType: "fork" | "kilo"
}
export type NestedMarker = {
  type: "inline" | "block"
  startLine: number
  endLine: number
  markerType: "fork" | "kilo"
  families: MarkerFamily[]
  outerStartLine: number
}

export function scope(args: string[]) {
  const raw = args.find((arg) => arg.startsWith("--base="))
  return {
    candidate: raw?.slice("--base=".length) || "upstream/main",
    worktree: args.includes("--worktree"),
    explicit: !!raw,
  }
}

function git(args: string[]): { code: number; out: string; err: string } {
  const res = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
  return { code: res.status ?? 1, out: res.stdout ?? "", err: res.stderr ?? "" }
}

function fatalGit(args: string[]): string {
  const res = git(args)
  if (res.code !== 0) {
    console.error(`Fatal Git error (git ${args.join(" ")}): ${res.err.trim() || res.out.trim() || `exit ${res.code}`}`)
    process.exit(1)
  }
  return res.out
}

function show(ref: string, file: string): string | null {
  const res = git(["show", `${ref}:${file}`])
  if (res.code === 0) return res.out
  if (res.err.includes("does not exist in") || res.err.includes("exists on disk, but not in")) return null
  console.error(`Fatal Git error (git show ${ref}:${file}): ${res.err.trim()}`)
  process.exit(1)
  return null
}

function ignored(file: string): boolean {
  const f = file.replaceAll("\\", "/")
  const name = path.basename(f)
  if (/\.(?:md|json|lock|lockb|css|scss|less|png|jpg|svg|ico|wav)$/.test(name)) return true
  if (/^\.|^(?:\.changeset|\.husky|\.github|\.vscode|dist|out|script)\//.test(f)) return true
  if (f.startsWith("packages/kilo-docs/") || /(?:^|\/)(?:test|tests|fixture|fixtures|stories|__snapshots__)\//.test(f))
    return true
  if (/\.(?:stories|test|spec)\./.test(f) || f.includes("/gen/")) return true
  return !!path.extname(f) && !SOURCE_EXTS.has(path.extname(f))
}

export function getFileZone(file: string): FileZone {
  const f = file.replaceAll("\\", "/")
  if (f.startsWith("packages/kilo-vscode/") || f.startsWith("packages/kilo-ui/")) return "kilo_exclusive"
  if (f.split("/").some((part) => part.startsWith("kilo-") || part.includes("kilocode"))) return "kilo_backend"
  return "shared_opencode"
}

export function stripMarkerComments(line: string): string {
  let out = ""
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ""
    if (quote) {
      out += c
      if (c === "\\") out += line[++i] ?? ""
      else if (c === quote) quote = ""
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
      continue
    }
    if (c === "/" && line[i + 1] === "/") {
      if (/^\/\/\s*(?:fork_change|kilocode_change)\b/.test(line.slice(i))) break
      out += line.slice(i)
      break
    }
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2)
      if (end >= 0 && ANY.test(line.slice(i, end + 2))) {
        i = end + 1
        continue
      }
    }
    out += c
  }
  return out
    .replace(/\{\s*\}/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchChurnLines(added: string[], removed: string[]): Set<number> {
  const a = added.map(stripMarkerComments),
    b = removed.map(stripMarkerComments)
  const dp = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1] + 1 : Math.max(dp[i + 1]![j], dp[i]![j + 1])
  const out = new Set<number>()
  let i = 0,
    j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.add(i++)
      j++
    } else if (dp[i + 1]![j] >= dp[i]![j + 1]) i++
    else j++
  }
  return out
}

export function takeChurnMatches(candidates: { line: number; text: string }[], removed: Map<string, number>): number[] {
  const out: number[] = []
  for (const item of candidates) {
    const key = stripMarkerComments(item.text),
      count = removed.get(key) ?? 0
    if (key && count) {
      out.push(item.line)
      removed.set(key, count - 1)
    }
  }
  return out
}

function mask(line: string): string {
  let out = "",
    quote = ""
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? ""
    if (quote) {
      out += c === quote ? c : " "
      if (c === quote) quote = ""
      if (c === "\\") {
        out += " "
        i++
      }
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      out += c
    } else if (c === "/" && line[i + 1] === "/") {
      out += line.slice(i)
      break
    } else out += c
  }
  return out
}

function familiesIn(text: string): MarkerFamily[] {
  const out = new Set<MarkerFamily>()
  for (const match of mask(text).matchAll(/(?:\/\/|\{?\s*\/\*|#)\s*(fork_change|kilocode_change)\b/g))
    out.add(match[1] === "fork_change" ? "fork" : "kilo")
  return [...out]
}

function commentFamilies(text: string): MarkerFamily[] {
  const out = new Set<MarkerFamily>()
  for (const match of text.matchAll(/\b(fork_change|kilocode_change)\b/g))
    out.add(match[1] === "fork_change" ? "fork" : "kilo")
  return [...out]
}

function addDiagnostic(errors: string[], diagnostics: Diagnostic[], message: string, families: MarkerFamily[] = []) {
  const unique = [...new Set(families)],
    text = unique.length > 1 ? `${message} (markers: ${markerNames(unique)})` : message
  errors.push(text)
  diagnostics.push({ message: text, families: unique })
}

function isFatal(families: readonly MarkerFamily[]): boolean {
  return families.length === 0 || families.includes("fork")
}

function splitLines(content: string): string[] {
  return content.endsWith("\n") ? content.split(/\r?\n/).slice(0, -1) : content.split(/\r?\n/)
}

function unchangedLines(diff: string, before: number, after: number): Map<number, number> {
  const out = new Map<number, number>()
  let old = 1,
    current = 1
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!match) continue
    const removed = match[2] == null ? 1 : Number(match[2]),
      added = match[4] == null ? 1 : Number(match[4]),
      oldStart = Number(match[1]) + (removed ? 0 : 1),
      currentStart = Number(match[3]) + (added ? 0 : 1)
    while (old < oldStart && current < currentStart) out.set(current++, old++)
    old = oldStart + removed
    current = currentStart + added
  }
  while (old <= before && current <= after) out.set(current++, old++)
  return out
}

function headerLine(lines: string[]): string {
  const i = lines.findIndex((line) => line.trim() && !line.startsWith("#!"))
  return lines[i] ?? ""
}

function markerEvents(line: string, zone: FileZone): MarkerEvent[] {
  const out: MarkerEvent[] = []
  const active = new Set<MarkerFamily>(
    zone === "shared_opencode" ? ["kilo"] : zone === "kilo_exclusive" ? ["fork"] : ["fork", "kilo"],
  )
  const re = /(?:\/\/|\{?\s*\/\*|#)\s*(fork_change|kilocode_change)\b(?:\s+(start|end)\b|(\s*-\s*new\s*file\b))?/g
  for (const match of mask(line).matchAll(re)) {
    const family = match[1] === "fork_change" ? "fork" : "kilo"
    if (!active.has(family)) continue
    out.push({
      family,
      kind: match[2] === "start" ? "start" : match[2] === "end" ? "end" : match[3] ? "whole_file" : "inline",
      index: match.index ?? 0,
    })
  }
  return out
}

function activeMarker(line: string, zone: FileZone): boolean {
  return markerEvents(line, zone).length > 0
}

type CommentScan = { inside: Set<number>; markers: Set<number>; spans: { start: number; end: number }[] }
function comments(lines: string[], zone?: FileZone): CommentScan {
  const inside = new Set<number>(),
    markers = new Set<number>(),
    spans: { start: number; end: number }[] = []
  let open = false,
    start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (open) {
      const close = line.indexOf("*/"),
        text = close < 0 ? line : line.slice(0, close)
      if (zone === undefined ? ANY.test(text) : activeMarker(text, zone)) markers.add(i + 1)
      if (start > 0) inside.add(i + 1)
      if (close < 0) {
        continue
      }
      if (start > 0) spans.push({ start, end: i + 1 })
      open = false
      start = -1
    }
    let p = 0
    while (p < line.length) {
      if (line[p] === "/" && line[p + 1] === "*") {
        const close = line.indexOf("*/", p + 2)
        if (close < 0) {
          open = true
          start = line.slice(0, p).trim() ? -1 : i + 1
          if (!line.slice(0, p).trim()) inside.add(i + 1)
          break
        }
        p = close + 2
        continue
      }
      if (line[p] === "/" && line[p + 1] === "/") break
      p++
    }
  }
  return { inside, markers, spans }
}

export function blockCommentMarkerLines(lines: string[], word?: string, zone?: FileZone): Set<number> {
  const found = comments(lines, zone).markers
  return word ? new Set([...found].filter((n) => new RegExp(`\\b${word}\\b`).test(mask(lines[n - 1] ?? "")))) : found
}

export function renderedMarkerLines(lines: string[], zone?: FileZone): number[] {
  const sourceText = lines.join("\n")
  if (zone === undefined ? !ANY.test(sourceText) : !lines.some((line) => activeMarker(line, zone))) return []
  const source = ts.createSourceFile("scan.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    found = new Set<number>()
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      let pos = node.getStart(source)
      for (const part of node.getText(source).split("\n")) {
        if (zone === undefined ? ANY.test(part) : activeMarker(part, zone))
          found.add(source.getLineAndCharacterOfPosition(pos).line + 1)
        pos += part.length + 1
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return [...found].sort((a, b) => a - b)
}

export function newFileHeaderError(lines: string[], zone: FileZone): string | null {
  const i = lines.findIndex((line) => line.trim() && !line.startsWith("#!")),
    line = mask(lines[i] ?? "")
  const ok =
    zone === "shared_opencode"
      ? KILO_NEW
      : zone === "kilo_exclusive"
        ? FORK_NEW
        : new RegExp(`${FORK_NEW.source}|${KILO_NEW.source}`)
  if (ok.test(line)) return null
  const expected =
    zone === "shared_opencode"
      ? "kilocode_change"
      : zone === "kilo_exclusive"
        ? "fork_change"
        : "fork_change or kilocode_change"
  return `Line ${i + 1}: new file requires '${expected} - new file' on its first non-shebang line`
}

export function parseCoveredRanges(lines: string[], zone: FileZone) {
  const covered = new Set<number>(),
    markers: MarkerBlock[] = [],
    nestedMarkers: NestedMarker[] = [],
    errors: string[] = [],
    diagnostics: Diagnostic[] = [],
    inside = comments(lines, zone).inside
  const first = lines.findIndex((line) => line.trim() && !line.startsWith("#!"))
  const active = new Set<MarkerFamily>(
    zone === "shared_opencode" ? ["kilo"] : zone === "kilo_exclusive" ? ["fork"] : ["fork", "kilo"],
  )
  let whole = -1
  const header = mask(lines[first] ?? "")
  for (const [family, pattern] of [
    ["fork", FORK_NEW],
    ["kilo", KILO_NEW],
  ] as const) {
    if (!active.has(family) || !pattern.test(header)) continue
    whole = first + 1
    markers.push({ type: "whole_file", startLine: whole, endLine: lines.length, markerType: family })
    for (let i = 1; i <= lines.length; i++) covered.add(i)
  }
  const stacks = new Map<MarkerFamily, MarkerStack[]>([
    ["fork", []],
    ["kilo", []],
  ])
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1,
      line = lines[i] ?? "",
      masked = mask(line),
      events = markerEvents(line, zone).filter((event) => event.kind !== "whole_file" || n !== whole)
    const all = [...masked.matchAll(/(?:\/\/|\{?\s*\/\*|#)\s*(fork_change|kilocode_change)\b/g)]
    const allFamilies = all.map((match): MarkerFamily => (match[1] === "fork_change" ? "fork" : "kilo"))
    const lineFamilies = [...new Set([...allFamilies, ...events.map((event) => event.family)])]
    for (const match of all) {
      const family = match[1] === "fork_change" ? "fork" : "kilo"
      if (!active.has(family))
        addDiagnostic(errors, diagnostics, `Line ${n}: forbidden '${markerName(family)}' in ${zone} file`, lineFamilies)
    }
    if (inside.has(n) && all.length)
      addDiagnostic(errors, diagnostics, `Line ${n}: marker inside a block/JSDoc comment`, lineFamilies)
    for (const match of line.matchAll(/\/\*[^]*?\*\//g)) {
      const text = match[0]
      if (
        /\b(?:fork_change|kilocode_change)\b/.test(text) &&
        !/^\s*\/\*+\s*(?:fork_change|kilocode_change)\b[^*]*\*\/\s*$/.test(text)
      )
        addDiagnostic(errors, diagnostics, `Line ${n}: marker inside a block/JSDoc comment`, [
          ...new Set([...lineFamilies, ...commentFamilies(text)]),
        ])
    }
    for (const m of masked.matchAll(BLOCK)) {
      const rest = masked.slice((m.index ?? 0) + m[0].length).trimStart()
      if (rest && !rest.startsWith("/*") && /^[=+\-*/%&|?:]/.test(rest))
        addDiagnostic(errors, diagnostics, `Line ${n}: marker has code after it on the same line`, [
          ...new Set([...lineFamilies, ...familiesIn(m[0])]),
        ])
    }
    let structural = false
    for (const event of events) {
      const stack = stacks.get(event.family)!
      if (event.kind === "start") {
        const outer = stack.at(-1)
        if (outer)
          nestedMarkers.push({
            type: "block",
            startLine: n,
            endLine: n,
            markerType: event.family,
            families: [...new Set([event.family, ...lineFamilies])],
            outerStartLine: outer.line,
          })
        stack.push({ line: n, families: lineFamilies })
        covered.add(n)
        structural = true
        continue
      }
      if (event.kind === "end") {
        const top = stack.at(-1)
        if (!top)
          addDiagnostic(
            errors,
            diagnostics,
            `Line ${n}: '${markerName(event.family)} end' without an active start block`,
            lineFamilies,
          )
        else {
          stack.pop()
          markers.push({ type: "block", startLine: top.line, endLine: n, markerType: event.family })
          covered.add(n)
        }
        structural = true
        continue
      }
      const outer = stack.at(-1)
      if (outer)
        nestedMarkers.push({
          type: "inline",
          startLine: n,
          endLine: n,
          markerType: event.family,
          families: [...new Set([event.family, ...lineFamilies])],
          outerStartLine: outer.line,
        })
      else markers.push({ type: "inline", startLine: n, endLine: n, markerType: event.family })
      covered.add(n)
    }
    if ([...stacks.values()].some((stack) => stack.length) && !structural) covered.add(n)
  }
  for (const [family, stack] of stacks)
    for (const top of stack)
      addDiagnostic(
        errors,
        diagnostics,
        `Line ${top.line}: unclosed '${markerName(family)} start' block at end of file`,
        top.families,
      )
  return { coveredLines: covered, markers, nestedMarkers, errors, diagnostics, wholeFileMarkerLine: whole }
}

type Block = { startLine: number; endLine: number; lines: string[]; uncoveredLines: number[]; isCovered: boolean }
export function groupAddedLines(added: number[], lines: string[], covered: Set<number>): Block[] {
  const out: Block[] = []
  for (const n of added) {
    const last = out.at(-1)
    if (!last || n !== last.endLine + 1)
      out.push({ startLine: n, endLine: n, lines: [], uncoveredLines: [], isCovered: true })
    else last.endLine = n
  }
  for (const b of out) {
    b.lines = lines.slice(b.startLine - 1, b.endLine)
    b.uncoveredLines = added.filter((n) => n >= b.startLine && n <= b.endLine && !covered.has(n))
    b.isCovered = !b.uncoveredLines.length
  }
  return out
}
export function formatMissingBlock(block: Block): string[] {
  const out = [
    `   [MISSING] L${block.startLine}-L${block.endLine} (${block.uncoveredLines.length} uncovered line${block.uncoveredLines.length === 1 ? "" : "s"})`,
  ]
  for (const n of block.uncoveredLines.slice(0, MAX_PREVIEW))
    out.push(`     L${n}: ${(block.lines[n - block.startLine] ?? "").trim() || "(blank line)"}`)
  return out
}

export function templateSpans(lines: string[]): boolean[] {
  const out = Array.from({ length: lines.length }, () => false)
  let open = false
  for (let i = 0; i < lines.length; i++) {
    let ticks = 0,
      quote = ""
    for (let j = 0; j < (lines[i] ?? "").length; j++) {
      const c = lines[i]![j]
      if (c === "\\") {
        j++
        continue
      }
      if (quote) {
        if (c === quote) quote = ""
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === "`") ticks++
    }
    out[i] = open || ticks > 0
    if (ticks % 2) open = !open
  }
  return out
}
export function isStructural(line: string): boolean {
  const t = line.trim()
  return !t || /^[\s{}()[\];,>]+$/.test(t) || /^<\/?[\w.]*\s*>$/.test(t) || /^\/>$/.test(t)
}

function toolingDirective(line: string): boolean {
  return /^(?:\/\/|\/\*+|\*|#)\s*(?:prettier-ignore|eslint-disable(?:-next-line|-line)?|eslint-enable)\b/.test(
    line.trim(),
  )
}

function inlineSafe(line: string): boolean {
  const text = line.trim()
  if (!text || /[({[]$/.test(text) || text.endsWith("=>")) return false
  return !/(?:&&|\|\||[?:+\-*/%=<>!])$/.test(text)
}

function inlineCandidates(markers: MarkerBlock[], real: Set<number>, lines: string[]) {
  return markers.flatMap((marker) => {
    if (marker.type !== "block" || marker.markerType !== "fork") return []
    const changed = [...real].filter((line) => line > marker.startLine && line < marker.endLine)
    if (changed.length !== 1) return []
    const line = changed[0]!,
      text = lines[line - 1] ?? ""
    return inlineSafe(text) && !ANY.test(text)
      ? [{ startLine: marker.startLine, endLine: marker.endLine, line, text }]
      : []
  })
}

function fragmentedCandidates(markers: MarkerBlock[], real: Set<number>) {
  const blocks = markers
    .filter((marker) => marker.type === "block" && marker.markerType === "fork")
    .sort((a, b) => a.startLine - b.startLine)
  return blocks.flatMap((first, index) => {
    const second = blocks[index + 1]
    if (!second) return []
    const gap = second.startLine - first.endLine - 1
    return gap >= 0 &&
      gap <= 4 &&
      [...real].some((line) => line <= first.endLine) &&
      [...real].some((line) => line >= second.startLine)
      ? [{ first: first.startLine, second: second.startLine, gap }]
      : []
  })
}
export function classifyOverwrap(
  interior: number[],
  added: Set<number>,
  lines: string[],
  spans: boolean[],
  churn = new Set<number>(),
) {
  const comment = comments(lines).inside,
    meaningfulLines: number[] = [],
    templateLines: number[] = [],
    churnLines: number[] = []
  for (const n of interior) {
    if (added.has(n) || comment.has(n) || isStructural(lines[n - 1] ?? "")) continue
    if (spans[n - 1]) templateLines.push(n)
    else if (churn.has(n)) churnLines.push(n)
    else meaningfulLines.push(n)
  }
  return {
    base: interior.filter((n) => !added.has(n)).length,
    meaningful: meaningfulLines.length,
    trivial: interior.filter((n) => !added.has(n)).length - meaningfulLines.length,
    meaningfulLines,
    templateLines,
    churnLines,
    excessive: meaningfulLines.length > 0,
  }
}

export function parseAuditSource(file: string, content: string): ts.SourceFile | null {
  const ext = path.extname(file),
    kind =
      ext === ".tsx"
        ? ts.ScriptKind.TSX
        : ext === ".jsx"
          ? ts.ScriptKind.JSX
          : [".js", ".mjs", ".cjs"].includes(ext)
            ? ts.ScriptKind.JS
            : ext === ".ts"
              ? ts.ScriptKind.TS
              : null
  return kind === null ? null : ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
}
export function structureCuts(source: ts.SourceFile, startLine: number, endLine: number) {
  const out: { kind: string; startLine: number; endLine: number }[] = []
  const lo = startLine + 1,
    hi = endLine - 1
  const walk = (node: ts.Node) => {
    if (!ts.isSourceFile(node)) {
      const a = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        b = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      if ((a >= lo && a <= hi && b > hi) || (b >= lo && b <= hi && a < lo))
        out.push({ kind: ts.SyntaxKind[node.kind] ?? "SyntaxNode", startLine: a, endLine: b })
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return out.filter((x, i) => !out.some((y, j) => j < i && y.startLine <= x.startLine && y.endLine >= x.endLine))
}

export function detachedHeader(
  source: ts.SourceFile,
  startLine: number,
  endLine: number,
): { kind: string; line: number } | null {
  const header = endLine - 1
  let found: { kind: string; line: number } | null = null
  const walk = (node: ts.Node) => {
    const bodyNode = ts.isFunctionLike(node) && "body" in node ? node.body : undefined
    if (found || !ts.isFunctionLike(node) || !bodyNode) {
      ts.forEachChild(node, walk)
      return
    }
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const body = source.getLineAndCharacterOfPosition(bodyNode.getStart(source)).line + 1
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    if (start <= header && body === header && end > endLine)
      found = { kind: ts.SyntaxKind[node.kind] ?? "Callable", line: header }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

export type StructuralFinding = {
  category: "STRUCTURE_SPLIT" | "DETACHED_HEADER"
  kind: string
  startLine: number
  endLine: number
}

export function matchFindings(
  current: StructuralFinding[],
  base: StructuralFinding[],
  same: (line: number) => number | undefined,
): StructuralFinding[] {
  const free = [...base],
    out: StructuralFinding[] = []
  for (const finding of current) {
    const start = same(finding.startLine),
      end = same(finding.endLine)
    const index =
      start == null || end == null
        ? -1
        : free.findIndex(
            (item) =>
              item.category === finding.category &&
              item.kind === finding.kind &&
              item.startLine === start &&
              item.endLine === end,
          )
    if (index < 0) out.push(finding)
    else free.splice(index, 1)
  }
  return out
}

function structuralFindings(source: ts.SourceFile, startLine: number, endLine: number): StructuralFinding[] {
  const out: StructuralFinding[] = [],
    header = detachedHeader(source, startLine, endLine)
  if (header) out.push({ category: "DETACHED_HEADER", kind: header.kind, startLine: header.line, endLine: header.line })
  for (const cut of structureCuts(source, startLine, endLine))
    out.push({ category: "STRUCTURE_SPLIT", kind: cut.kind, startLine: cut.startLine, endLine: cut.endLine })
  return out
}

type Audit = {
  file: string
  total: number
  covered: number
  blocks: Block[]
  redundant: MarkerBlock[]
  nested: NestedMarker[]
  errors: string[]
  diagnostics: Diagnostic[]
  overwrap: {
    startLine: number
    endLine: number
    meaningful: number
    trivial: number
    meaningfulLines: number[]
    templateLines: number[]
    churnLines: number[]
    excessive: boolean
  }[]
  inline: { startLine: number; endLine: number; line: number; text: string }[]
  fragmented: { first: number; second: number; gap: number }[]
}
function auditFile(cfg: { worktree: boolean; base: string; ref: string }, file: string, isNew: boolean): Audit | null {
  const content = cfg.worktree
    ? existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf8")
      : null
    : show("HEAD", file)
  if (content == null) return null
  const lines = splitLines(content),
    zone = getFileZone(file),
    parsed = parseCoveredRanges(lines, zone),
    base = isNew ? null : show(cfg.base, file),
    baseLines = base == null ? [] : splitLines(base),
    prior = base == null ? null : parseCoveredRanges(baseLines, zone),
    errors = [...parsed.errors],
    diagnostics = [...parsed.diagnostics],
    add = (message: string, families: MarkerFamily[] = []) => addDiagnostic(errors, diagnostics, message, families)
  if (isNew) {
    const e = newFileHeaderError(lines, zone)
    if (e) add(e, familiesIn(lines[lines.findIndex((line) => line.trim() && !line.startsWith("#!"))] ?? ""))
  } else if (parsed.wholeFileMarkerLine !== -1) {
    const historical =
      parsed.markers.every((marker) => marker.type !== "whole_file" || marker.markerType === "kilo") &&
      headerLine(lines) === headerLine(baseLines)
    if (!historical)
      add(
        `Line ${parsed.wholeFileMarkerLine}: whole-file '- new file' marker used on an existing file`,
        parsed.markers
          .filter((marker) => marker.type === "whole_file" && marker.startLine === parsed.wholeFileMarkerLine)
          .map((marker) => marker.markerType),
      )
  }
  if (/\.(?:tsx|jsx)$/.test(file))
    for (const n of renderedMarkerLines(lines, zone))
      add(`Line ${n}: marker renders as text in JSX children`, familiesIn(lines[n - 1] ?? ""))
  const diff = isNew ? "" : fatalGit(["diff", "--unified=0", "--diff-filter=AMRT", cfg.ref, "--", file])
  const added: number[] = []
  let churn = new Set<number>()
  const sameHunkRemoved = new Map<string, number>()
  const hunks: { added: { line: number; text: string }[]; removed: string[] }[] = []
  let hunk: (typeof hunks)[number] | null = null
  const flushHunk = () => {
    if (!hunk) return
    const matches = matchChurnLines(
      hunk.added.map((item) => item.text),
      hunk.removed,
    )
    const used = new Set<number>()
    for (const index of matches) {
      const key = stripMarkerComments(hunk.added[index]!.text)
      churn.add(hunk.added[index]!.line)
      const removed = hunk.removed.findIndex((line, n) => !used.has(n) && stripMarkerComments(line) === key)
      if (removed >= 0) {
        used.add(removed)
        sameHunkRemoved.set(key, (sameHunkRemoved.get(key) ?? 0) + 1)
      }
    }
  }
  let pos = 0
  for (const row of diff.split("\n")) {
    if (row.startsWith("@@")) {
      flushHunk()
      const m = row.match(/\+(\d+)(?:,\d+)?/)
      pos = Number(m?.[1] ?? 0)
      hunk = { added: [], removed: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (row.startsWith("+") && !row.startsWith("+++")) {
      const item = { line: pos++, text: row.slice(1) }
      added.push(item.line)
      hunk.added.push(item)
      continue
    }
    if (row.startsWith("-") && !row.startsWith("---")) hunk.removed.push(row.slice(1))
  }
  flushHunk()
  const lineage = unchangedLines(diff, baseLines.length, lines.length),
    same = (line: number) => {
      const old = lineage.get(line)
      return old != null && lines.at(line - 1) === baseLines.at(old - 1) ? old : undefined
    },
    baseBlock = (marker: MarkerBlock) => {
      if (!prior) return undefined
      const start = same(marker.startLine),
        end = same(marker.endLine)
      if (start == null || end == null) return undefined
      return prior.markers.find(
        (item) =>
          item.type === marker.type &&
          item.markerType === marker.markerType &&
          item.startLine === start &&
          item.endLine === end,
      )
    },
    inherited = (marker: MarkerBlock) => baseBlock(marker) != null,
    inheritedNested = (marker: NestedMarker) => {
      if (!prior) return false
      const start = same(marker.startLine),
        outerStart = same(marker.outerStartLine),
        outer = parsed.markers.find(
          (item) =>
            item.type === "block" && item.markerType === marker.markerType && item.startLine === marker.outerStartLine,
        )
      if (start == null || outerStart == null || !outer || !inherited(outer)) return false
      if (marker.type === "block") {
        const inner = parsed.markers.find(
          (item) =>
            item.type === "block" && item.markerType === marker.markerType && item.startLine === marker.startLine,
        )
        if (!inner || !inherited(inner)) return false
      }
      return prior.nestedMarkers.some(
        (item) =>
          item.type === marker.type &&
          item.markerType === marker.markerType &&
          item.startLine === start &&
          item.outerStartLine === outerStart,
      )
    }
  if (isNew) for (let n = 1; n <= lines.length; n++) added.push(n)
  if (!isNew) {
    const baseCount = new Map<string, number>(),
      currentCount = new Map<string, number>()
    for (const line of baseLines.filter(Boolean)) {
      const key = stripMarkerComments(line)
      if (key) baseCount.set(key, (baseCount.get(key) ?? 0) + 1)
    }
    for (const line of lines) {
      const key = stripMarkerComments(line)
      if (key) currentCount.set(key, (currentCount.get(key) ?? 0) + 1)
    }
    const removedCount = new Map<string, number>()
    const addedKeys = new Set(hunks.flatMap((target) => target.added.map((item) => stripMarkerComments(item.text))))
    for (const target of hunks)
      for (const item of target.removed) {
        const key = stripMarkerComments(item)
        const companion = target.removed.some(
          (other) => stripMarkerComments(other) !== key && addedKeys.has(stripMarkerComments(other)),
        )
        // A structural closer inside a larger deletion is not move evidence by
        // itself. Require another normalized line from that deleted construct
        // to reappear before consuming it cross-hunk; diff cannot otherwise
        // distinguish this from an unrelated punctuation line.
        if (key && (!isStructural(item) || target.removed.length === 1 || companion))
          removedCount.set(key, (removedCount.get(key) ?? 0) + 1)
      }
    const remaining = new Map(removedCount)
    for (const [key, count] of sameHunkRemoved) remaining.set(key, (remaining.get(key) ?? 0) - count)
    const candidates = hunks.flatMap((target) =>
      target.added.flatMap((item) => {
        const key = stripMarkerComments(item.text)
        const survives = (currentCount.get(key) ?? 0) >= (baseCount.get(key) ?? 0) && !(removedCount.get(key) ?? 0)
        return key && !survives && !churn.has(item.line) ? [item] : []
      }),
    )
    const removed = new Map<string, number>()
    for (const [key, count] of remaining) if (count > 0) removed.set(key, count)
    // Diff cannot distinguish an intentional move from an unrelated identical delete/add.
    // The normalized one-to-one fallback deliberately treats both as a move.
    churn = new Set([...churn, ...takeChurnMatches(candidates, removed)])
  }
  const real = added.filter(
    (n) => !churn.has(n) && !toolingDirective(lines[n - 1] ?? "") && stripMarkerComments(lines[n - 1] ?? ""),
  )
  const blocks = groupAddedLines(real, lines, parsed.coveredLines),
    redundant = parsed.markers.filter(
      (m) =>
        m.markerType === "fork" &&
        m.type !== "whole_file" &&
        !real.some((n) => n >= m.startLine && n <= m.endLine && stripMarkerComments(lines[n - 1] ?? "")) &&
        ![...churn].some((n) => n >= m.startLine && n <= m.endLine && stripMarkerComments(lines[n - 1] ?? "")),
    ),
    overwrap: Audit["overwrap"] = [],
    realSet = new Set(real)
  for (const m of parsed.markers.filter((x) => x.type === "block" && x.markerType === "fork")) {
    const f = classifyOverwrap(
      Array.from({ length: Math.max(0, m.endLine - m.startLine - 1) }, (_, i) => i + m.startLine + 1),
      new Set(real),
      lines,
      templateSpans(lines),
      churn,
    )
    if (f.base) overwrap.push({ startLine: m.startLine, endLine: m.endLine, ...f })
  }
  const source = parseAuditSource(file, content),
    baseSource = base == null ? null : parseAuditSource(file, base)
  if (parsed.wholeFileMarkerLine < 0 && source)
    for (const m of parsed.markers.filter((x) => x.type === "block")) {
      const counterpart = baseBlock(m),
        priorFindings =
          counterpart && baseSource ? structuralFindings(baseSource, counterpart.startLine, counterpart.endLine) : [],
        findings = structuralFindings(source, m.startLine, m.endLine)
      for (const finding of matchFindings(findings, priorFindings, same)) {
        if (finding.category === "DETACHED_HEADER")
          add(
            `[DETACHED_HEADER] L${m.startLine}-L${m.endLine}: ${finding.kind} header ends before its body at L${finding.startLine}`,
            [m.markerType],
          )
        else
          add(
            `[STRUCTURE_SPLIT] L${m.startLine}-L${m.endLine}: ${finding.kind} L${finding.startLine}-L${finding.endLine}`,
            [m.markerType],
          )
      }
    }
  return {
    file,
    total: real.length,
    covered: real.filter((n) => parsed.coveredLines.has(n)).length,
    blocks,
    redundant,
    nested: parsed.nestedMarkers.filter((marker) => !inheritedNested(marker)),
    errors,
    diagnostics,
    overwrap,
    inline: inlineCandidates(parsed.markers, realSet, lines),
    fragmented: fragmentedCandidates(parsed.markers, realSet),
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => /^--(?:fix|dry-run)(?:=.*)?$/.test(arg))) {
    console.error("fork-audit is read-only; use the report and edit annotations manually.")
    process.exit(2)
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run script/fork-audit.ts [--worktree] [--base=<ref>] [--overwrap-report] [--inline-report] [paths...]",
    )
    process.exit(0)
  }
  const s = scope(args),
    repo = git(["rev-parse", "--git-dir"])
  if (repo.code) {
    console.error(`${ROOT} is not a Git repository`)
    process.exit(1)
  }
  if (git(["rev-parse", "--verify", s.candidate]).code) {
    console.error(`Candidate base reference '${s.candidate}' is unavailable`)
    process.exit(1)
  }
  const merge = git(["merge-base", "HEAD", s.candidate])
  const base = merge.out.trim()
  if (merge.code || !base) {
    console.error(`Cannot resolve merge-base for HEAD and candidate '${s.candidate}': ${merge.err.trim()}`)
    process.exit(1)
  }
  const ref = s.worktree ? base : `${base}...HEAD`
  console.log(
    `Candidate base ref: '${s.candidate}'\nResolved merge-base: '${base}'\nScanning fork modifications against: ${ref}...\n` +
      `ℹ️  NOTE: Upstream marker anomalies inherited from upstream/main must NOT be modified to prevent rebase conflicts.\n`,
  )
  const status = fatalGit(["diff", "--name-status", "-M", ref]).trim().split("\n").filter(Boolean)
  const renameDestinations = new Set(
    status
      .filter((line) => /^R\d*\t/.test(line))
      .map((line) => line.split("\t")[2])
      .filter((file): file is string => file !== undefined),
  )
  const deletionOnly = status.filter((line) => line.startsWith("D\t")).length
  const changed = fatalGit(["diff", "--name-only", "--diff-filter=AMRT", ref]).trim().split("\n").filter(Boolean),
    untracked = s.worktree
      ? fatalGit(["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean)
      : [],
    allFiles = [...new Set([...changed, ...untracked])],
    ignoredCount = allFiles.filter(ignored).length,
    files = allFiles.filter((f) => !ignored(f) && !renameDestinations.has(f)),
    wanted = args.filter((x) => !x.startsWith("--")),
    targets = wanted.length ? files.filter((f) => wanted.some((x) => f === x || f.startsWith(`${x}/`))) : files,
    newFiles = new Set(fatalGit(["diff", "--name-only", "--diff-filter=A", ref]).trim().split("\n").filter(Boolean))
  let bad = 0,
    warnings = 0
  const overwrapReport = args.includes("--overwrap-report")
  const inlineReport = args.includes("--inline-report")
  const fragmentReport = args.includes("--fragment-report")
  const overwraps: {
    file: string
    start: number
    end: number
    meaningful: number
    trivial: number
    lines: number[]
  }[] = []
  const fragments: { file: string; first: number; second: number; gap: number }[] = []
  let audited = 0
  for (const file of targets) {
    const result = auditFile({ worktree: s.worktree, base, ref }, file, newFiles.has(file) || untracked.includes(file))
    if (!result) continue
    audited++
    const missing = result.blocks.filter((b) => !b.isCovered)
    const nestedHard = result.nested.filter((item) => isFatal(item.families)).length,
      diagnosticHard = result.diagnostics.filter((item) => isFatal(item.families)).length,
      hard = missing.length + result.redundant.length + nestedHard + diagnosticHard,
      soft = result.nested.length + result.diagnostics.length - nestedHard - diagnosticHard
    bad += hard
    warnings += soft
    console.log(`${hard ? "FAIL" : "PASS"} ${result.file} (${result.covered}/${result.total} lines covered)`)
    for (const diagnostic of result.diagnostics)
      console.log(`   [${isFatal(diagnostic.families) ? "ERROR" : "WARNING"}] ${diagnostic.message}`)
    for (const n of result.nested)
      console.log(`   [${isFatal(n.families) ? "ERROR" : "WARNING"}] [NESTED] L${n.startLine}-L${n.endLine}`)
    for (const b of missing) for (const line of formatMissingBlock(b)) console.log(line)
    for (const r of result.redundant) console.log(`   [REDUNDANT] L${r.startLine}-L${r.endLine}`)
    for (const o of result.overwrap) {
      overwraps.push({
        file,
        start: o.startLine,
        end: o.endLine,
        meaningful: o.meaningful,
        trivial: o.trivial,
        lines: o.meaningfulLines,
      })
    }
    if (inlineReport)
      for (const candidate of result.inline)
        console.log(
          `   [INLINE] L${candidate.startLine}-L${candidate.endLine}: single changed line L${candidate.line} (${candidate.text.trim()})`,
        )
    fragments.push(...result.fragmented.map((fragment) => ({ file, ...fragment })))
    console.log("")
  }
  if (overwrapReport) {
    console.log("OVERWRAP REPORT (read-only advisory)")
    for (const item of overwraps)
      console.log(
        `   [${item.meaningful ? "CAPTURED" : "CONTEXT"}] ${item.file} L${item.start}-L${item.end}: upstream ${item.meaningful}, context ${item.trivial}`,
      )
    for (const item of overwraps) if (item.lines.length) console.log(`     upstream lines: ${item.lines.join(", ")}`)
  }
  if (fragmentReport) {
    console.log("FRAGMENTED REGIONS (read-only advisory)")
    for (const fragment of fragments)
      console.log(`   [FRAGMENTED] ${fragment.file} L${fragment.first}/L${fragment.second}: ${fragment.gap} line gap`)
  }
  console.log(
    `Summary: files audited ${audited}; ignored ${ignoredCount}; rename destinations skipped ${renameDestinations.size}; deletion-only ${deletionOnly}; findings ${bad} (fatal); warnings ${warnings} (non-fatal); candidate '${s.candidate}'; merge-base '${base}'`,
  )
  if (bad) {
    console.log(
      "\n⚠️  CRITICAL NOTICE: If marker anomalies (STRUCTURE_SPLIT, NESTED, DETACHED_HEADER) originate from upstream commits, DO NOT TOUCH THEM. Modifying upstream marker annotations creates severe merge conflicts during future rebases on upstream/main. Only fix annotations for changes introduced by this fork.",
    )
  }
  process.exit(bad ? 1 : 0)
}
if (import.meta.main) main()
