#!/usr/bin/env bun
// kilocode_change - new file

import { appendFileSync } from "node:fs"

const VERSION = 1
const REPO = "catgirl3d/kilocode"
const LABEL = "upstream-conflict-watch"
const MAX_BODY_BYTES = 65536
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const OID = /^[0-9a-f]{40,64}$/
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const decoder = new TextDecoder("utf-8", { fatal: true })

export type MergeResult =
  | { status: "clean" | "conflict"; files: string[] }
  | { status: "error"; files: []; error: string }

export type Probe = {
  status: "clean" | "conflict" | "error"
  fork: string | null
  upstream: string | null
  ahead: number | null
  files: string[]
  error?: string
}

export type State = {
  v: number
  fork: string
  upstream: string
  checkedAt: string
  status: "clean" | "conflict"
  files: Record<string, string>
  announce: { maxAnnounced: number; lastAnnouncedAt: string | null }
}

export type StateError = { error: string }
export type StateInput = State | StateError | null

export type Plan = {
  status: "clean" | "conflict" | "error"
  state: State | null
  edit?: { title: string; body: string }
  reopen?: true
  close?: true
  comment?: string
  error?: string
}

type Command = { code: number; out: Uint8Array; err: string } | { spawnError: string }

function command(cwd: string, args: string[]): Command {
  try {
    const result = Bun.spawnSync({ cmd: args, cwd, stdout: "pipe", stderr: "pipe" })
    return { code: result.exitCode, out: result.stdout, err: Buffer.from(result.stderr).toString() }
  } catch (error) {
    return { spawnError: error instanceof Error ? error.message : String(error) }
  }
}

function commandError(name: string, result: Command) {
  if ("spawnError" in result) return `${name} spawn failed: ${result.spawnError}`
  return `${name} failed with exit ${result.code}: ${result.err.trim() || "unknown error"}`
}

function isOid(value: unknown): value is string {
  return typeof value === "string" && OID.test(value)
}

function splitNul(raw: Uint8Array) {
  const parts: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0) continue
    parts.push(raw.slice(start, i))
    start = i + 1
  }
  parts.push(raw.slice(start))
  return parts
}

function decode(raw: Uint8Array): { value: string } | { error: string } {
  try {
    return { value: decoder.decode(raw) }
  } catch (error) {
    return { error: `merge-tree output is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function conflictPath(token: string) {
  const match = token.match(/^[0-7]{6} [0-9a-f]{40,64} [0-3]\t([\s\S]*)$/)
  return match?.[1] ?? token
}

export function parseMergeTree(raw: Uint8Array, exitCode: number): MergeResult {
  if (exitCode !== 0 && exitCode !== 1)
    return { status: "error", files: [], error: `merge-tree exited with ${exitCode}` }

  const tokens = splitNul(raw).map(decode)
  const invalid = tokens.find((token) => "error" in token)
  if (invalid && "error" in invalid) return { status: "error", files: [], error: invalid.error }
  const text = tokens.map((token) => ("value" in token ? token.value : ""))
  if (text.length < 2 || !isOid(text[0]))
    return { status: "error", files: [], error: "merge-tree output has no valid tree OID" }

  const rest = text.slice(1)
  if (rest.at(-1) === "") rest.pop()
  if (rest.some((token) => token.length === 0))
    return { status: "error", files: [], error: "merge-tree output has an empty path token" }
  if (exitCode === 0) {
    if (rest.length > 0) return { status: "error", files: [], error: "clean merge-tree output contains paths" }
    return { status: "clean", files: [] }
  }

  const files = [...new Set(rest.map(conflictPath))].sort()
  if (files.some((file) => file.length === 0))
    return { status: "error", files: [], error: "merge-tree output has an empty path" }
  return { status: "conflict", files }
}

function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
}

function iso(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false
  return new Date(value).toISOString() === value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stateError(error: string): StateError {
  return { error }
}

export function parseState(body: string): StateInput {
  const matches = [...body.matchAll(/<!--\s*upstream-conflict-watch-state:\s*([\s\S]*?)\s*-->/g)]
  if (matches.length === 0) return null
  if (matches.length !== 1) return stateError("invalid state: expected exactly one state comment")

  const parsed = (() => {
    try {
      return { value: JSON.parse(matches[0]?.[1] ?? "") as unknown }
    } catch (error) {
      return stateError(`invalid state JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if ("error" in parsed) return parsed
  const value = parsed.value
  if (!record(value) || !keys(value, ["v", "fork", "upstream", "checkedAt", "status", "files", "announce"]))
    return stateError("invalid state schema: top-level keys do not match")
  if (typeof value.v !== "number" || !Number.isInteger(value.v) || value.v < 0)
    return stateError("invalid state schema: v must be an integer")
  if (!isOid(value.fork) || !isOid(value.upstream)) return stateError("invalid state schema: refs must be OIDs")
  if (!iso(value.checkedAt)) return stateError("invalid state schema: checkedAt must be an ISO timestamp")
  if (value.status !== "clean" && value.status !== "conflict")
    return stateError("invalid state schema: status is invalid")
  if (!record(value.files) || Object.values(value.files).some((item) => typeof item !== "string" || !iso(item)))
    return stateError("invalid state schema: files must map paths to ISO timestamps")
  if (!Object.keys(value.files).every((item) => item.length > 0))
    return stateError("invalid state schema: empty file path")
  if (
    !record(value.announce) ||
    !keys(value.announce, ["maxAnnounced", "lastAnnouncedAt"]) ||
    typeof value.announce.maxAnnounced !== "number" ||
    !Number.isInteger(value.announce.maxAnnounced) ||
    value.announce.maxAnnounced < 0 ||
    (value.announce.lastAnnouncedAt !== null && !iso(value.announce.lastAnnouncedAt))
  )
    return stateError("invalid state schema: announce is invalid")
  if (
    value.v === VERSION &&
    value.status === "clean" &&
    (Object.keys(value.files).length > 0 ||
      value.announce.maxAnnounced !== 0 ||
      value.announce.lastAnnouncedAt !== null)
  )
    return stateError("invalid state schema: clean state must have empty files and announce")

  return value as State
}

function copyState(value: State): State {
  return { ...value, files: { ...value.files }, announce: { ...value.announce } }
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

export function formatMsk(value: string) {
  const date = new Date(Date.parse(value) + 3 * HOUR)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC+3`
}

function short(value: string) {
  return value.slice(0, 12)
}

function fileCount(value: number) {
  return `${value} file${value === 1 ? "" : "s"}`
}

function commitCount(value: number) {
  return `${value} commit${value === 1 ? "" : "s"}`
}

function tablePath(value: string) {
  const path = value.replaceAll("|", "\\|")
  const runs = [...path.matchAll(/`+/g)].map((match) => match[0].length)
  const delimiter = "`".repeat(Math.max(0, ...(runs.length > 0 ? runs : [0])) + 1)
  return `${delimiter}${path}${delimiter}`
}

function escapedState(value: State) {
  return JSON.stringify(value).replaceAll("<", "\\u003C").replaceAll(">", "\\u003E")
}

function stateComment(value: State) {
  return `<!-- upstream-conflict-watch-state: ${escapedState(value)} -->`
}

function aheadText(value: number | null) {
  return value === null
    ? "Upstream has moved ahead (commit count unavailable)."
    : `Upstream is ${commitCount(value)} ahead.`
}

export function renderBody(state: State, probe: Probe, now: string): string | StateError {
  if (!probe.fork || !probe.upstream) return stateError("cannot render body without fork and upstream refs")
  const header = `Checked: fork@${short(probe.fork)} × upstream@${short(probe.upstream)} — ${formatMsk(now)}`
  const comment = stateComment(state)
  const body = (() => {
    if (state.status === "clean") return `${comment}\n\n✅ No conflicts\n\n${header}`
    if (Object.keys(state.files).length === 0)
      return `${comment}\n\n⚠️ Merge conflict; the list of file paths is unavailable\n\n${header}\n\n${aheadText(probe.ahead)}`

    const paths = Object.keys(state.files).sort()
    const rows = paths.slice(0, 100).map((file) => `| ${tablePath(file)} | ${formatMsk(state.files[file] ?? now)} |`)
    const more = paths.length > 100 ? `\n\n+${paths.length - 100} more` : ""
    return `${comment}\n\n⚠️ Upstream conflicts: **${fileCount(paths.length)}**\n\n${header}\n${aheadText(probe.ahead)}\n\n| File | First seen |\n|---|---|\n${rows.join("\n")}${more}`
  })()
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return stateError(`issue body exceeds ${MAX_BODY_BYTES} bytes`)
  return body
}

function errorPlan(message: string): Plan {
  return { status: "error", state: null, error: message }
}

function stateErrorInput(value: StateInput): value is StateError {
  return record(value) && "error" in value && typeof value.error === "string" && !Object.hasOwn(value, "v")
}

function sameFiles(previous: State | null, files: Record<string, string>) {
  if (!previous) return false
  const left = Object.keys(previous.files).sort()
  const right = Object.keys(files).sort()
  return left.length === right.length && left.every((file, index) => file === right[index])
}

function cooldown(last: string | null, now: string) {
  return last === null || Date.parse(now) - Date.parse(last) >= DAY
}

function list(value: string[]) {
  return value.slice(0, 20).map(tablePath).join(", ")
}

function firstComment(count: number, files: string[], probe: Probe) {
  const paths = files.length > 0 ? `\n\nFirst paths: ${list(files)}` : ""
  return `⚠️ New upstream conflicts: **${fileCount(count)}** @catgirl3d${paths}\n\n${aheadText(probe.ahead)}`
}

function structuralComment(probe: Probe) {
  return `⚠️ New upstream conflict: paths unavailable @catgirl3d\n\n${aheadText(probe.ahead)}`
}

function growthComment(count: number, previous: number | null, added: string[], probe: Probe) {
  const before = previous === null ? "unknown" : String(previous)
  const paths = added.length > 0 ? `\n\nAdded: +${list(added)}` : ""
  return `📈 Upstream conflicts grew: **${count}** (was ${before}) @catgirl3d${paths}\n\n${aheadText(probe.ahead)}`
}

function edit(state: State, probe: Probe, now: string, title: string): { title: string; body: string } | StateError {
  const body = renderBody(state, probe, now)
  return typeof body === "string" ? { title, body } : body
}

export function decide(input: { state: StateInput; probe: Probe; now: string; issueOpen: boolean }): Plan {
  if (stateErrorInput(input.state)) return errorPlan(input.state.error)
  if (input.probe.status === "error") return errorPlan(input.probe.error ?? "probe failed")
  if (!isOid(input.probe.fork) || !isOid(input.probe.upstream)) return errorPlan("probe has invalid refs")

  const source = input.state
  const legacy = source !== null && source.v !== VERSION
  const previous =
    source === null
      ? null
      : legacy
        ? { ...copyState(source), v: VERSION, announce: { maxAnnounced: 0, lastAnnouncedAt: null } }
        : copyState(source)
  const moved = previous === null || previous.fork !== input.probe.fork || previous.upstream !== input.probe.upstream
  if (input.probe.status === "clean") {
    const next: State = {
      v: VERSION,
      fork: input.probe.fork,
      upstream: input.probe.upstream,
      checkedAt: input.now,
      status: "clean",
      files: {},
      announce: { maxAnnounced: 0, lastAnnouncedAt: null },
    }
    // Body edits notify nobody, so a closed issue still gets its state synced; only an open one is closed.
    const synced = !legacy && !moved && previous?.status === "clean"
    if (!input.issueOpen && synced) return { status: "clean", state: next }
    const change = edit(next, input.probe, input.now, `✅ Upstream conflict watch: clean — ${formatMsk(input.now)}`)
    if ("error" in change) return errorPlan(change.error)
    if (!input.issueOpen) return { status: "clean", state: next, edit: change }
    return { status: "clean", state: next, edit: change, close: true }
  }

  const current = [...new Set(input.probe.files)].sort()
  const count = current.length
  const known = previous?.files ?? {}
  const files = Object.fromEntries(current.map((file) => [file, known[file] ?? input.now]))
  // Baselines come from the last announcement, not the previous run, so a delayed digest covers the whole growth.
  const announce = previous?.announce ?? { maxAnnounced: 0, lastAnnouncedAt: null }
  const first = previous === null || previous.status === "clean"
  const grown = count > announce.maxAnnounced && cooldown(announce.lastAnnouncedAt, input.now)
  const comment = (() => {
    if (count === 0) return first ? structuralComment(input.probe) : undefined
    if (!grown) return undefined
    if (first) return firstComment(count, current, input.probe)
    const since = announce.lastAnnouncedAt
    const added =
      since == null
        ? current.filter((file) => !Object.hasOwn(known, file))
        : current.filter((file) => Date.parse(files[file] ?? input.now) > Date.parse(since))
    return growthComment(count, announce.maxAnnounced === 0 ? null : announce.maxAnnounced, added, input.probe)
  })()

  const next: State = {
    v: VERSION,
    fork: input.probe.fork,
    upstream: input.probe.upstream,
    checkedAt: input.now,
    status: "conflict",
    files,
    announce: {
      maxAnnounced: grown ? count : announce.maxAnnounced,
      lastAnnouncedAt: comment === undefined ? announce.lastAnnouncedAt : input.now,
    },
  }
  // Body edits notify nobody, so the state stays in sync even while the issue is closed.
  const stale = legacy || moved || first || !sameFiles(previous, files) || comment !== undefined
  const title =
    count === 0
      ? "⚠️ Upstream conflict watch: merge conflict (paths unavailable)"
      : `⚠️ Upstream conflict watch: ${count} conflicting ${count === 1 ? "file" : "files"}`
  const change = stale ? edit(next, input.probe, input.now, title) : undefined
  if (change && "error" in change) return errorPlan(change.error)
  const plan: Plan = { status: "conflict", state: next }
  if (change) plan.edit = change
  if (comment) plan.comment = comment
  if (comment && !input.issueOpen) plan.reopen = true
  return plan
}

function fetchRefs(cwd: string): { fork: string; upstream: string } | StateError {
  const origin = command(cwd, [
    "git",
    "fetch",
    "--no-tags",
    "--force",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ])
  if (!("code" in origin) || origin.code !== 0) return stateError(commandError("origin fetch", origin))
  const kilo = command(cwd, [
    "git",
    "fetch",
    "--no-tags",
    "--force",
    "https://github.com/kilo-org/kilocode",
    "+refs/heads/main:refs/remotes/upstream-watch/main",
  ])
  if (!("code" in kilo) || kilo.code !== 0) return stateError(commandError("upstream fetch", kilo))
  const local = command(cwd, ["git", "rev-parse", "origin/main"])
  if (!("code" in local) || local.code !== 0) return stateError(commandError("origin ref lookup", local))
  const remote = command(cwd, ["git", "rev-parse", "upstream-watch/main"])
  if (!("code" in remote) || remote.code !== 0) return stateError(commandError("upstream ref lookup", remote))
  const fork = Buffer.from(local.out).toString("utf8").trim()
  const upstream = Buffer.from(remote.out).toString("utf8").trim()
  if (!isOid(fork) || !isOid(upstream)) return stateError("ref lookup returned an invalid OID")
  return { fork, upstream }
}

function aheadCount(cwd: string, fork: string, upstream: string) {
  const result = command(cwd, ["git", "rev-list", "--count", `${fork}..${upstream}`])
  if (!("code" in result) || result.code !== 0) return null
  const value = Number.parseInt(Buffer.from(result.out).toString("utf8").trim(), 10)
  return Number.isInteger(value) && value >= 0 ? value : null
}

export function probe(cwd = process.cwd()): Probe {
  const refs = fetchRefs(cwd)
  if ("error" in refs) return { status: "error", fork: null, upstream: null, ahead: null, files: [], error: refs.error }
  const result = command(cwd, ["git", "merge-tree", "--write-tree", "--no-messages", "-z", refs.fork, refs.upstream])
  if (!("code" in result))
    return {
      status: "error",
      fork: refs.fork,
      upstream: refs.upstream,
      ahead: null,
      files: [],
      error: commandError("merge-tree", result),
    }
  const merged = parseMergeTree(result.out, result.code)
  const count = aheadCount(cwd, refs.fork, refs.upstream)
  if (merged.status === "error")
    return { status: "error", fork: refs.fork, upstream: refs.upstream, ahead: count, files: [], error: merged.error }
  return { status: merged.status, fork: refs.fork, upstream: refs.upstream, ahead: count, files: merged.files }
}

function fresh(cwd: string, initial: Probe) {
  const current = fetchRefs(cwd)
  if ("error" in current) return current
  if (current.fork === initial.fork && current.upstream === initial.upstream) return { probe: initial }
  const retry = probe(cwd)
  if (retry.status === "error") return stateError(retry.error ?? "probe failed")
  const checked = fetchRefs(cwd)
  if ("error" in checked) return checked
  if (checked.fork !== retry.fork || checked.upstream !== retry.upstream) return { skip: true as const }
  return { probe: retry }
}

function gh(cwd: string, args: string[]) {
  return command(cwd, ["gh", ...args])
}

type Issue = { number: number; open: boolean; body: string }

function issueValue(value: unknown): Issue | StateError {
  if (
    !record(value) ||
    typeof value.number !== "number" ||
    !Number.isInteger(value.number) ||
    typeof value.body !== "string" ||
    (value.state !== "OPEN" && value.state !== "CLOSED")
  )
    return stateError("invalid gh issue response")
  return { number: value.number, open: value.state === "OPEN", body: value.body }
}

function json(raw: Uint8Array, name: string): { value: unknown } | StateError {
  try {
    return { value: JSON.parse(Buffer.from(raw).toString("utf8")) }
  } catch (error) {
    return stateError(`invalid ${name} response: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function view(cwd: string, number: string): Issue | StateError {
  const result = gh(cwd, ["issue", "view", number, "--repo", REPO, "--json", "number,state,body"])
  if (!("code" in result) || result.code !== 0) return stateError(commandError("gh issue view", result))
  const parsed = json(result.out, "gh issue")
  if ("error" in parsed) return parsed
  return issueValue(parsed.value)
}

export function missingIssue(error: string) {
  return /Could not resolve to an issue/i.test(error) || /HTTP 404: Not Found/i.test(error)
}

function discover(cwd: string): Issue | null | StateError {
  const number = process.env.ISSUE_NUMBER?.trim()
  if (number) {
    if (!/^\d+$/.test(number)) return stateError("ISSUE_NUMBER must be a positive integer")
    const issue = view(cwd, number)
    if (!("error" in issue) || !missingIssue(issue.error)) return issue
  }
  const result = gh(cwd, [
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    LABEL,
    "--state",
    "all",
    "--json",
    "number,state",
  ])
  if (!("code" in result) || result.code !== 0) return stateError(commandError("gh issue list", result))
  const parsed = json(result.out, "gh issue list")
  if ("error" in parsed) return parsed
  const values = parsed.value
  if (!Array.isArray(values)) return stateError("invalid gh issue list response: expected an array")
  if (values.length > 1) {
    const numbers = values.map((item) => (record(item) ? item.number : "?")).join(", ")
    return stateError(`multiple ${LABEL} issues found: ${numbers}`)
  }
  if (values.length === 0) return null
  const value = values[0]
  if (!record(value) || !Number.isInteger(value.number))
    return stateError("invalid gh issue list response: invalid issue number")
  return view(cwd, String(value.number))
}

function load(cwd: string): { issue: Issue | null; state: State | null } | { error: string; code: number } {
  const issue = discover(cwd)
  if (issue == null) return { issue: null, state: null }
  if ("error" in issue) return { error: issue.error, code: 1 }
  const state = parseState(issue.body)
  if (state == null) return { error: "invalid state: state comment is missing from an existing issue", code: 2 }
  if ("error" in state) return { error: state.error, code: 2 }
  return { issue, state }
}

function createLabel(cwd: string) {
  gh(cwd, [
    "label",
    "create",
    LABEL,
    "--repo",
    REPO,
    "--color",
    "FBCA04",
    "--description",
    "Upstream conflict watch",
    "--force",
  ])
}

function createIssue(cwd: string, content: { title: string; body: string }): number | StateError {
  const result = gh(cwd, [
    "issue",
    "create",
    "--repo",
    REPO,
    "--label",
    LABEL,
    "--title",
    content.title,
    "--body",
    content.body,
  ])
  if (!("code" in result) || result.code !== 0) return stateError(commandError("gh issue create", result))
  const output = Buffer.from(result.out).toString("utf8")
  const match = output.match(/\/issues\/(\d+)(?:\D|$)/) ?? output.match(/^\s*(\d+)\s*$/)
  if (match == null) return stateError("gh issue create returned no issue number")
  return Number(match[1])
}

function publish(cwd: string, number: number, plan: Plan) {
  const id = String(number)
  if (plan.reopen) {
    const result = gh(cwd, ["issue", "reopen", id, "--repo", REPO])
    if (!("code" in result) || result.code !== 0) return commandError("gh issue reopen", result)
  }
  if (plan.comment) {
    const result = gh(cwd, ["issue", "comment", id, "--repo", REPO, "--body", plan.comment])
    if (!("code" in result) || result.code !== 0) return commandError("gh issue comment", result)
  }
  if (plan.edit) {
    const result = gh(cwd, ["issue", "edit", id, "--repo", REPO, "--title", plan.edit.title, "--body", plan.edit.body])
    if (!("code" in result) || result.code !== 0) return commandError("gh issue edit", result)
  }
  if (plan.close) {
    const result = gh(cwd, ["issue", "close", id, "--repo", REPO])
    if (!("code" in result) || result.code !== 0) return commandError("gh issue close", result)
  }
  return null
}

function summary(message: string) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  try {
    appendFileSync(file, `${message}\n`)
  } catch (error) {
    console.error(`failed to write GITHUB_STEP_SUMMARY: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function report(message: string, code: number) {
  console.error(message)
  summary(message)
  process.exitCode = code
}

function cliArgs() {
  const args = process.argv.slice(2)
  const allowed = new Set(["--dry-run", "--probe-only"])
  const unknown = args.find((arg) => !allowed.has(arg))
  if (unknown || (args.includes("--dry-run") && args.includes("--probe-only"))) return null
  return { dry: args.includes("--dry-run"), only: args.includes("--probe-only") }
}

function main() {
  const args = cliArgs()
  if (args == null) {
    report("usage: bun script/upstream-conflict-watch.ts [--dry-run|--probe-only]", 2)
    return
  }
  const cwd = process.cwd()
  const initial = probe(cwd)
  if (args.only) {
    console.log(JSON.stringify(initial))
    if (initial.status === "error") report(initial.error ?? "probe failed", 1)
    return
  }
  if (initial.status === "error") {
    report(initial.error ?? "probe failed", 1)
    return
  }
  const loaded = load(cwd)
  if ("error" in loaded) {
    report(loaded.error, loaded.code)
    return
  }
  const open = loaded.issue?.open ?? true
  if (args.dry) {
    const plan = decide({ state: loaded.state, probe: initial, now: new Date().toISOString(), issueOpen: open })
    console.log(JSON.stringify({ probe: initial, plan }))
    if (plan.status === "error") report(plan.error ?? "dry-run failed", 1)
    return
  }

  const latest = fresh(cwd, initial)
  if ("error" in latest) {
    report(latest.error, 1)
    return
  }
  if ("skip" in latest) {
    console.log("skipped: refs moved")
    return
  }
  const plan = decide({ state: loaded.state, probe: latest.probe, now: new Date().toISOString(), issueOpen: open })
  if (plan.status === "error") {
    report(plan.error ?? "decision failed", 1)
    return
  }
  if (loaded.issue != null) {
    const error = publish(cwd, loaded.issue.number, plan)
    if (error != null) report(error, 1)
    return
  }
  if (plan.edit == null) {
    report("cannot create the issue: plan has no title and body", 1)
    return
  }
  createLabel(cwd)
  const number = createIssue(cwd, plan.edit)
  if (typeof number !== "number") {
    report(number.error, 1)
    return
  }
  console.log(`set repo variable UPSTREAM_CONFLICT_ISSUE_NUMBER to ${number}`)
  const error = publish(cwd, number, { ...plan, edit: undefined })
  if (error != null) report(error, 1)
}

if (import.meta.main) main()
