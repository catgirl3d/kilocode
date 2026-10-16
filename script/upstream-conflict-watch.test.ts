import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  decide,
  formatMsk,
  missingIssue,
  parseMergeTree,
  parseState,
  type Plan,
  type Probe,
  type State,
  type StateInput,
} from "./upstream-conflict-watch"

const dirs: string[] = []
const root = path.resolve(import.meta.dir, "..")

describe("missing issue matcher", () => {
  it("matches deleted issue errors without matching unrelated failures", () => {
    expect(
      missingIssue(
        "gh issue view failed with exit 1: GraphQL: Could not resolve to an issue or pull request with the number of 9. (repository.issue)",
      ),
    ).toBe(true)
    expect(missingIssue("gh issue view failed with exit 1: HTTP 404: Not Found (https://api.github.com/...)")).toBe(
      true,
    )
    expect(missingIssue("rate limit exceeded")).toBe(false)
    expect(missingIssue("network error")).toBe(false)
  })
})

function git(dir: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
  return Buffer.from(result.stdout).toString().trim()
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-conflict-watch-"))
  dirs.push(dir)
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Upstream Conflict Watch"])
  writeFileSync(path.join(dir, "shared.txt"), "base\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "base"])
  return dir
}

function pair(dir: string, files: string[] = ["shared.txt"]) {
  git(dir, ["checkout", "-q", "-b", "upstream"])
  for (const file of files) writeFileSync(path.join(dir, file), "upstream\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "upstream change"])
  const upstream = git(dir, ["rev-parse", "HEAD"])
  git(dir, ["checkout", "-q", "-b", "fork", "HEAD~1"])
  for (const file of files) writeFileSync(path.join(dir, file), "fork\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "fork change"])
  const fork = git(dir, ["rev-parse", "HEAD"])
  return { fork, upstream }
}

function merge(dir: string, fork: string, upstream: string) {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", dir, "merge-tree", "--write-tree", "--no-messages", "-z", fork, upstream],
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: result.exitCode, raw: Buffer.from(result.stdout) }
}

function sha(char: string) {
  return char.repeat(40)
}

function probe(status: Probe["status"], files: string[], fork = sha("f"), upstream = sha("e")): Probe {
  return { status, files, fork, upstream, ahead: files.length + 1 }
}

function state(
  status: State["status"],
  files: Record<string, string>,
  announce = 0,
  last: string | null = null,
): State {
  return {
    v: 1,
    fork: sha("f"),
    upstream: sha("e"),
    checkedAt: "2026-01-01T00:00:00.000Z",
    status,
    files,
    announce: { maxAnnounced: announce, lastAnnouncedAt: last },
  }
}

function names(count: number) {
  return Array.from({ length: count }, (_, i) => `file-${i + 1}.ts`)
}

// The script persists state only in the issue body, so a plan without an edit keeps the previous state.
function kept(plan: Plan, input: StateInput) {
  return plan.edit ? plan.state : input
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("merge-tree parser", () => {
  it("parses a real conflict as OID NUL path records", () => {
    const dir = repo()
    const refs = pair(dir)
    const merged = merge(dir, refs.fork, refs.upstream)
    const text = merged.raw.toString("utf8")

    expect(merged.code).toBe(1)
    expect(text.indexOf("\0")).toBeGreaterThan(0)
    expect(text.split("\0")[0]).toMatch(/^[0-9a-f]{40}$/)
    expect(parseMergeTree(merged.raw, merged.code)).toEqual({ status: "conflict", files: ["shared.txt"] })
  })

  it("parses a clean merge without paths", () => {
    const dir = repo()
    git(dir, ["checkout", "-q", "-b", "upstream"])
    writeFileSync(path.join(dir, "upstream.txt"), "upstream\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-qm", "upstream change"])
    const upstream = git(dir, ["rev-parse", "HEAD"])
    git(dir, ["checkout", "-q", "-b", "fork", "HEAD~1"])
    writeFileSync(path.join(dir, "fork.txt"), "fork\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-qm", "fork change"])
    const fork = git(dir, ["rev-parse", "HEAD"])
    const merged = merge(dir, fork, upstream)

    expect(merged.code).toBe(0)
    expect(parseMergeTree(merged.raw, merged.code)).toEqual({ status: "clean", files: [] })
  })

  it("keeps spaces and Unicode paths intact", () => {
    const dir = repo()
    const files = ["folder/space name.txt", "文件/路径.txt"]
    mkdirSync(path.join(dir, "folder"), { recursive: true })
    mkdirSync(path.join(dir, "文件"), { recursive: true })
    for (const file of files) writeFileSync(path.join(dir, file), "base\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-qm", "path base"])
    const refs = pair(dir, files)
    const merged = merge(dir, refs.fork, refs.upstream)

    expect(parseMergeTree(merged.raw, merged.code)).toEqual({ status: "conflict", files })
  })
})

describe("decide", () => {
  it("does not call an empty structural conflict a growth announcement", () => {
    const current = parseMergeTree(Buffer.from(`${sha("a")}\0`), 1)
    const plan = decide({
      state: state("clean", {}),
      probe: { ...probe(current.status, current.files), ahead: null },
      now: "2026-01-02T00:00:00.000Z",
      issueOpen: true,
    })

    expect(plan.status).toBe("conflict")
    expect(plan.comment).toContain("paths unavailable")
    expect(plan.comment).not.toContain("grew")
    expect(plan.edit?.title).toBe("⚠️ Upstream conflict watch: merge conflict (paths unavailable)")
    expect(plan.close).not.toBe(true)
    expect(plan.state?.announce).toEqual({ maxAnnounced: 0, lastAnnouncedAt: "2026-01-02T00:00:00.000Z" })
  })

  it("delivers a delayed digest after growth 1 to 2 to 5", () => {
    const t0 = "2026-01-01T00:00:00.000Z"
    const first = decide({ state: state("clean", {}), probe: probe("conflict", names(1)), now: t0, issueOpen: true })
    const second = decide({
      state: first.state,
      probe: probe("conflict", names(2)),
      now: "2026-01-01T02:00:00.000Z",
      issueOpen: true,
    })
    const third = decide({
      state: second.state,
      probe: probe("conflict", names(5)),
      now: "2026-01-01T04:00:00.000Z",
      issueOpen: true,
    })
    const delayed = decide({
      state: third.state,
      probe: probe("conflict", names(5)),
      now: "2026-01-02T01:00:00.000Z",
      issueOpen: true,
    })

    expect(first.comment).toContain("New upstream conflicts")
    expect(first.comment).toContain("Upstream is 2 commits ahead.")
    expect(second.comment).toBeUndefined()
    expect(second.state?.announce.maxAnnounced).toBe(1)
    expect(third.comment).toBeUndefined()
    expect(third.state?.announce.maxAnnounced).toBe(1)
    expect(delayed.comment).toBe(
      "📈 Upstream conflicts grew: **5** (was 1) @catgirl3d\n\n" +
        "Added: +`file-2.ts`, `file-3.ts`, `file-4.ts`, `file-5.ts`\n\n" +
        "Upstream is 6 commits ahead.",
    )
    expect(delayed.state?.announce.maxAnnounced).toBe(5)
  })

  it("reports an unknown baseline when paths appear after a structural announcement", () => {
    const structural = decide({
      state: state("clean", {}),
      probe: probe("conflict", []),
      now: "2026-01-01T00:00:00.000Z",
      issueOpen: true,
    })
    const paths = decide({
      state: kept(structural, state("clean", {})),
      probe: probe("conflict", names(2)),
      now: "2026-01-02T01:00:00.000Z",
      issueOpen: true,
    })

    expect(structural.comment).toContain("paths unavailable")
    expect(structural.state?.announce).toEqual({ maxAnnounced: 0, lastAnnouncedAt: "2026-01-01T00:00:00.000Z" })
    expect(paths.comment).toBe(
      "📈 Upstream conflicts grew: **2** (was unknown) @catgirl3d\n\n" +
        "Added: +`file-1.ts`, `file-2.ts`\n\n" +
        "Upstream is 3 commits ahead.",
    )
    expect(paths.state?.announce).toEqual({ maxAnnounced: 2, lastAnnouncedAt: "2026-01-02T01:00:00.000Z" })
  })

  it("does not announce 5 to 3 to 5 permutations", () => {
    const first = decide({
      state: state("clean", {}),
      probe: probe("conflict", names(5)),
      now: "2026-01-01T00:00:00.000Z",
      issueOpen: true,
    })
    const lower = decide({
      state: first.state,
      probe: probe("conflict", names(3)),
      now: "2026-01-01T02:00:00.000Z",
      issueOpen: true,
    })
    const restored = decide({
      state: lower.state,
      probe: probe("conflict", names(5)),
      now: "2026-01-01T04:00:00.000Z",
      issueOpen: true,
    })

    expect(first.comment).toBeDefined()
    expect(lower.comment).toBeUndefined()
    expect(restored.comment).toBeUndefined()
    expect(restored.state?.announce.maxAnnounced).toBe(5)
  })

  it("closes clean episodes, resets state, and announces the next episode", () => {
    const conflict = decide({
      state: state("clean", {}),
      probe: probe("conflict", ["old.ts"]),
      now: "2026-01-01T00:00:00.000Z",
      issueOpen: true,
    })
    const clean = decide({
      state: conflict.state,
      probe: probe("clean", []),
      now: "2026-01-02T00:00:00.000Z",
      issueOpen: true,
    })
    const next = decide({
      state: clean.state,
      probe: probe("conflict", ["new.ts"]),
      now: "2026-01-03T00:00:00.000Z",
      issueOpen: true,
    })

    expect(clean.close).toBe(true)
    expect(clean.state).toMatchObject({
      status: "clean",
      files: {},
      announce: { maxAnnounced: 0, lastAnnouncedAt: null },
    })
    expect(next.comment).toContain("New upstream conflicts")
    expect(next.state?.files["new.ts"]).toBe("2026-01-03T00:00:00.000Z")
  })

  it("turns malformed state JSON into an error plan with no actions", () => {
    const parsed = parseState("<!-- upstream-conflict-watch-state: {broken} -->")
    const plan = decide({ state: parsed, probe: probe("clean", []), now: "2026-01-02T00:00:00.000Z", issueOpen: true })

    expect(plan.status).toBe("error")
    expect(plan.error).toContain("invalid")
    expect(plan.edit).toBeUndefined()
    expect(plan.comment).toBeUndefined()
    expect(plan.close).toBeUndefined()
  })

  it("respects a manual close until a new announced maximum is reached", () => {
    const previous = state("conflict", { "one.ts": "2026-01-01T00:00:00.000Z" }, 1, "2026-01-01T00:00:00.000Z")
    const quiet = decide({
      state: previous,
      probe: probe("conflict", ["one.ts"]),
      now: "2026-01-01T01:00:00.000Z",
      issueOpen: false,
    })
    const after = kept(quiet, previous)
    const silent = decide({
      state: after,
      probe: probe("conflict", ["one.ts", "two.ts"]),
      now: "2026-01-01T02:00:00.000Z",
      issueOpen: false,
    })
    const growth = decide({
      state: kept(silent, after),
      probe: probe("conflict", ["one.ts", "two.ts"]),
      now: "2026-01-02T01:00:00.000Z",
      issueOpen: false,
    })

    expect(quiet.edit).toBeUndefined()
    expect(quiet.comment).toBeUndefined()
    expect(quiet.reopen).toBeUndefined()
    expect(silent.edit).toBeDefined()
    expect(silent.comment).toBeUndefined()
    expect(silent.reopen).toBeUndefined()
    expect(silent.state?.files["two.ts"]).toBe("2026-01-01T02:00:00.000Z")
    expect(growth.reopen).toBe(true)
    expect(growth.edit).toBeDefined()
    expect(growth.comment).toContain("Upstream conflicts grew: **2** (was 1) @catgirl3d\n\nAdded: +`two.ts`\n\n")
  })

  it("keeps the body in sync while closed and announces the next episode", () => {
    const start = state("clean", {})
    const conflict = decide({
      state: start,
      probe: probe("conflict", names(5)),
      now: "2026-01-01T00:00:00.000Z",
      issueOpen: true,
    })
    const after = kept(conflict, start)
    const clean = decide({
      state: after,
      probe: probe("clean", []),
      now: "2026-01-01T02:00:00.000Z",
      issueOpen: false,
    })
    const settled = kept(clean, after)
    const idle = decide({
      state: settled,
      probe: probe("clean", []),
      now: "2026-01-01T03:00:00.000Z",
      issueOpen: false,
    })
    const next = decide({
      state: kept(idle, settled),
      probe: probe("conflict", names(1)),
      now: "2026-01-01T04:00:00.000Z",
      issueOpen: false,
    })

    expect(conflict.comment).toContain("New upstream conflicts")
    expect(clean.edit?.body).toContain("✅ No conflicts")
    expect(clean.edit?.body).toContain("Checked: fork@ffffffffffff × upstream@eeeeeeeeeeee — 1 Jan 05:00 UTC+3")
    expect(clean.edit?.title).toBe("✅ Upstream conflict watch: clean — 1 Jan 05:00 UTC+3")
    expect(clean.close).toBeUndefined()
    expect(clean.reopen).toBeUndefined()
    expect(clean.comment).toBeUndefined()
    expect(settled).toMatchObject({
      status: "clean",
      files: {},
      announce: { maxAnnounced: 0, lastAnnouncedAt: null },
    })
    expect(idle.edit).toBeUndefined()
    expect(idle.close).toBeUndefined()
    expect(next.comment).toContain("New upstream conflicts: **1 file**")
    expect(next.edit?.title).toBe("⚠️ Upstream conflict watch: 1 conflicting file")
    expect(next.reopen).toBe(true)
    expect(next.edit).toBeDefined()
    expect(next.state?.announce).toEqual({ maxAnnounced: 1, lastAnnouncedAt: "2026-01-01T04:00:00.000Z" })
  })

  it("renders hostile paths without breaking markdown or the state comment", () => {
    const plan = decide({
      state: state("clean", {}),
      probe: probe("conflict", ["a|b", "tick`path", "bad-->path"]),
      now: "2026-01-02T00:00:00.000Z",
      issueOpen: true,
    })
    const body = plan.edit?.body ?? ""
    const json = body.match(/<!-- upstream-conflict-watch-state: ([\s\S]*?) -->/)?.[1] ?? ""

    expect(body).toContain("a\\|b")
    expect(body).toContain("`a\\|b`")
    expect(body).toContain("``tick`path``")
    expect(json).toContain("--\\u003E")
    expect(json).not.toContain("-->")
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it("does nothing when pair and composition are unchanged", () => {
    const now = "2026-01-02T00:00:00.000Z"
    const previous = state("conflict", { "same.ts": "2026-01-01T00:00:00.000Z" }, 1, now)
    const plan = decide({ state: previous, probe: probe("conflict", ["same.ts"]), now, issueOpen: true })

    expect(plan.edit).toBeUndefined()
    expect(plan.comment).toBeUndefined()
    expect(plan.reopen).toBeUndefined()
    expect(plan.close).toBeUndefined()
    expect(plan.state?.announce).toEqual(previous.announce)
  })

  it("rejects an issue body larger than GitHub's limit", () => {
    const files = Array.from({ length: 1100 }, (_, i) => `${"x".repeat(60)}-${i}.ts`)
    const plan = decide({
      state: state("clean", {}),
      probe: probe("conflict", files),
      now: "2026-01-02T00:00:00.000Z",
      issueOpen: true,
    })

    expect(plan.status).toBe("error")
    expect(plan.error).toContain("65536")
    expect(plan.edit).toBeUndefined()
    expect(plan.comment).toBeUndefined()
  })

  it("preserves files while resetting announcements for an older state version", () => {
    const old = state("conflict", { "old.ts": "2026-01-01T00:00:00.000Z" }, 7, "2026-01-01T00:00:00.000Z")
    old.v = 0
    const plan = decide({
      state: old,
      probe: probe("conflict", ["old.ts"]),
      now: "2026-01-02T00:00:00.000Z",
      issueOpen: true,
    })

    expect(plan.state?.v).toBe(1)
    expect(plan.state?.files).toEqual(old.files)
    expect(plan.comment).toContain("Upstream conflicts grew")
    expect(plan.state?.announce).toEqual({ maxAnnounced: 1, lastAnnouncedAt: "2026-01-02T00:00:00.000Z" })
    expect(plan.edit).toBeDefined()
  })

  it("keeps the parser source independent of package imports", () => {
    expect(readFileSync(path.join(root, "script", "upstream-conflict-watch.ts"), "utf8")).not.toContain("packages/")
  })
})

describe("time formatting", () => {
  it("renders timestamps in UTC+3 with day, month, and year rollover", () => {
    expect(formatMsk("2026-01-01T23:30:00.000Z")).toBe("2 Jan 02:30 UTC+3")
    expect(formatMsk("2026-01-31T23:30:00.000Z")).toBe("1 Feb 02:30 UTC+3")
    expect(formatMsk("2026-12-31T23:30:00.000Z")).toBe("1 Jan 02:30 UTC+3")
  })
})
