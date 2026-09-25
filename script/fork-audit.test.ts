import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  classifyOverwrap,
  detachedHeader,
  matchChurnLines,
  matchFindings,
  newFileHeaderError,
  parseAuditSource,
  parseCoveredRanges,
  renderedMarkerLines,
  scope,
  structureCuts,
  stripMarkerComments,
  takeChurnMatches,
  templateSpans,
} from "./fork-audit"

const root = path.resolve(import.meta.dir, "..")
const script = path.join(root, "script", "fork-audit.ts")
const dirs: string[] = []

function git(dir: string, args: string[]) {
  const r = Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(Buffer.from(r.stderr).toString())
  return Buffer.from(r.stdout).toString()
}

function fixture(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fork-audit-"))
  dirs.push(dir)
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Fork Audit"])
  mkdirSync(path.join(dir, "packages/kilo-vscode/src"), { recursive: true })
  writeFileSync(
    path.join(dir, "packages/kilo-vscode/src/view.ts"),
    "export const view = 1\nexport const stable = true\n",
  )
  writeFileSync(path.join(dir, "packages/kilo-vscode/src/deleted.ts"), "export const deleted = true\n")
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "base"])
  git(dir, ["branch", "upstream"])
  git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
  return dir
}

function run(dir: string, args: string[]) {
  const r = Bun.spawnSync({
    cmd: ["bun", script, ...args],
    cwd: dir,
    env: {
      ...process.env,
      FORK_AUDIT_ROOT: dir,
      GIT_CONFIG_GLOBAL: path.join(dir, "empty-config"),
      GIT_CONFIG_SYSTEM: path.join(dir, "empty-config"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: r.exitCode, out: `${Buffer.from(r.stdout).toString()}\n${Buffer.from(r.stderr).toString()}` }
}

function hashes(dir: string) {
  const file = path.join(dir, "packages/kilo-vscode/src/view.ts"),
    data = readFileSync(file)
  return {
    file: createHash("sha256").update(data).digest("hex"),
    head: git(dir, ["rev-parse", "HEAD"]),
    index: git(dir, ["diff", "--cached", "--raw"]),
    refs: git(dir, ["show-ref"]),
    config: createHash("sha256")
      .update(readFileSync(path.join(dir, ".git/config")))
      .digest("hex"),
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("read-only contract", () => {
  it("audits the restored kilo-gateway handler as 57/57", () => {
    const file = "packages/opencode/src/kilocode/server/httpapi/handlers/kilo-gateway.ts"
    const before = createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex")
    const result = Bun.spawnSync({
      cmd: ["bun", script, "--worktree", "--base=upstream/main", file],
      cwd: root,
      env: { ...process.env, FORK_AUDIT_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${Buffer.from(result.stdout).toString()}\n${Buffer.from(result.stderr).toString()}`
    expect(result.exitCode).toBe(0)
    expect(output).toContain("57/57 lines covered")
    expect(output).not.toContain("[MISSING]")
    expect(output).not.toContain("[ERROR]")
    expect(output).not.toContain("[NESTED]")
    expect(output).not.toContain("marker type mismatch")
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ).toBe(before)
  })

  it("keeps default candidate and explicit HEAD scope", () => {
    expect(scope([])).toEqual({ candidate: "upstream/main", worktree: false, explicit: false })
    expect(scope(["--worktree", "--base=HEAD"])).toEqual({ candidate: "HEAD", worktree: true, explicit: true })
  })

  it("preserves mixed markers, rationales, and bytes in every audit mode", () => {
    const dir = fixture(),
      file = path.join(dir, "packages/kilo-vscode/src/view.ts")
    writeFileSync(
      file,
      `// kilocode_change start: historical rationale\n/**\n * // fork_change start\n */\nexport const view = 2 // fork_change rationale\n// kilocode_change end\n# fork_change\n`,
    )
    git(dir, ["add", "-A"])
    const before = hashes(dir)
    const modes = [
      ["--worktree", "--base=upstream"],
      ["--worktree", "--base=upstream", "--overwrap-report"],
      ["--worktree", "--base=upstream", "--inline-report"],
      ["--worktree", "--base=upstream", "--fragment-report"],
      ["--help"],
      ["-h"],
    ]
    for (const mode of modes) run(dir, mode)
    expect(hashes(dir)).toEqual({ ...before, index: git(dir, ["diff", "--cached", "--raw"]) })
    expect(readFileSync(file, "utf8")).toContain("historical rationale")
  }, 30_000)

  for (const args of [["--fix"], ["--fix", "--dry-run"], ["--dry-run"], ["--fix=1"], ["--dry-run=1"]])
    it(`rejects retired flags: ${args.join(" ")}`, () => {
      const dir = fixture(),
        before = hashes(dir),
        result = run(dir, [...args, "--worktree", "--base=upstream"])
      expect(result.code).not.toBe(0)
      expect(result.out).toContain("fork-audit is read-only")
      expect(hashes(dir)).toEqual(before)
    })

  it("reports merge-base provenance for diverged candidate history without writing", () => {
    const dir = fixture()
    git(dir, ["checkout", "-qb", "upstream-diverged"])
    writeFileSync(path.join(dir, "packages/kilo-vscode/src/view.ts"), "export const view = 3\n")
    git(dir, ["commit", "-qam", "diverged"])
    git(dir, ["checkout", "-q", "main"])
    const before = hashes(dir)
    const result = run(dir, ["--worktree", "--base=upstream-diverged"])
    expect(result.out).toContain("Candidate base ref: 'upstream-diverged'")
    expect(result.out).toContain("Resolved merge-base:")
    expect(hashes(dir)).toEqual(before)
  })

  it("reports an existing-file whole-file marker instead of rewriting it", () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "// fork_change - new file\nexport const view = 2\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream"])
    expect(result.code).toBe(1)
    expect(result.out).toContain("whole-file '- new file' marker used on an existing file")
  })

  it("reports detached callable headers while accepting a complete author block", () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "// fork_change start\nexport function view() {\n// fork_change end\n  return 2\n}\n",
    )
    const detached = run(dir, ["--worktree", "--base=upstream"])
    expect(detached.code).toBe(1)
    expect(detached.out).toContain("[DETACHED_HEADER]")
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "// fork_change start\nexport function view() {\n  return 2\n}\n// fork_change end\n",
    )
    expect(run(dir, ["--worktree", "--base=upstream"]).out).not.toContain("[DETACHED_HEADER]")
  })

  it("ignores structure findings from an unchanged merge-base marker block", () => {
    const file = "packages/opencode/src/inherited-structure.ts",
      source =
        "export const stable = true\n// kilocode_change start\nexport function inherited() {\n// kilocode_change end\n  return 1\n}\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), `export const local = 2 // kilocode_change\n${source}`)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(1/1 lines covered)")
    expect(result.out).not.toContain("[DETACHED_HEADER]")
    expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
  })

  it("reports a new Kilo structure anomaly inside unchanged merge-base marker boundaries", () => {
    const file = "packages/opencode/src/changed-inside.ts",
      source = "const items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), source.replace("const b = 2", "items.forEach((x) => {"))
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("[STRUCTURE_SPLIT]")
    expect(result.out).toContain("[DETACHED_HEADER]")
  })

  it("suppresses an equivalent inherited structure anomaly on the corresponding base block", () => {
    const file = "packages/opencode/src/unchanged-inside.ts",
      source = "const items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), `export const local = 1 // kilocode_change\n${source}`)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
    expect(result.out).not.toContain("[DETACHED_HEADER]")
  })

  it("reports a changed Kilo structure kind on a mapped inherited block", () => {
    const file = "packages/opencode/src/changed-kind.ts",
      source = "// kilocode_change start\nfunction inherited() {\n// kilocode_change end\n  return 1\n}\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), source.replace("function inherited() {", "const inherited = () => {"))
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("[STRUCTURE_SPLIT]")
    expect(result.out).toContain("[DETACHED_HEADER]")
  })

  it("keeps inherited structure suppression across deletion and hunk shifts", () => {
    const file = "packages/opencode/src/shifted-inside.ts",
      source =
        "export const removed = true\nconst items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\nexport const local = 1\n",
      dir = fixture({ [file]: source })
    writeFileSync(
      path.join(dir, file),
      source.replace("export const removed = true\n", "").replace("local = 1", "local = 2 // kilocode_change"),
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
    expect(result.out).not.toContain("[DETACHED_HEADER]")
  })

  it("ignores nesting inherited unchanged from the merge-base", () => {
    const file = "packages/opencode/src/inherited-nesting.ts",
      source =
        "export const local = 1\n// kilocode_change start\nexport const inherited = 1 // kilocode_change\n// kilocode_change end\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), source.replace("local = 1", "local = 2 // kilocode_change"))
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(1/1 lines covered)")
    expect(result.out).not.toContain("[NESTED]")
  })

  it("maps inherited marker boundaries across deletion and multiple hunks", () => {
    const file = "packages/opencode/src/inherited-multihunk.ts",
      source =
        "export const removed = true\nexport const stable = true\n// kilocode_change start\nexport function inherited() {\n// kilocode_change end\n  return 1\n}\nexport const local = 1\n",
      dir = fixture({ [file]: source })
    writeFileSync(
      path.join(dir, file),
      source.replace("export const removed = true\n", "").replace("local = 1", "local = 2 // kilocode_change"),
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("[DETACHED_HEADER]")
    expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
  })

  it("reports a merge-base Kilo block whose marker boundary changed in the fork", () => {
    const file = "packages/opencode/src/changed-structure.ts",
      source = "// kilocode_change start\nexport function inherited() {\n// kilocode_change end\n  return 1\n}\n"
    for (const boundary of ["start", "end"]) {
      const dir = fixture({ [file]: source })
      writeFileSync(path.join(dir, file), source.replace(boundary, `${boundary}: fork rationale`))
      const result = run(dir, ["--worktree", "--base=upstream", file])
      expect(result.code).toBe(0)
      expect(result.out).toContain("[DETACHED_HEADER]")
      expect(result.out).toContain("[STRUCTURE_SPLIT]")
    }
  })

  it("reports an inner Kilo marker added inside an inherited block", () => {
    const file = "packages/opencode/src/changed-nesting.ts",
      source = "// kilocode_change start\nexport const inherited = 1\n// kilocode_change end\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), source.replace("inherited = 1", "inherited = 1 // kilocode_change"))
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("[NESTED]")
  })

  it("prints inline, fragmentation, and detailed overwrap reports only when requested", () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "// fork_change start\nexport const view = 2\nexport const stable = true\n// fork_change end\n\n\n// fork_change start\nconst extra = 1\n// fork_change end\n",
    )
    const plain = run(dir, ["--worktree", "--base=upstream"])
    expect(plain.out).not.toContain("[INLINE]")
    expect(plain.out).not.toContain("[CAPTURED]")
    const reports = run(dir, [
      "--worktree",
      "--base=upstream",
      "--inline-report",
      "--fragment-report",
      "--overwrap-report",
    ])
    expect(reports.out).toContain("[INLINE]")
    expect(reports.out).toContain("FRAGMENTED REGIONS")
    expect(reports.out).toContain("OVERWRAP REPORT")
  })

  it("reports ignored, rename, and deletion-only counts", () => {
    const dir = fixture()
    mkdirSync(path.join(dir, "packages/kilo-vscode/fixtures"), { recursive: true })
    writeFileSync(path.join(dir, "packages/kilo-vscode/fixtures/ignored.ts"), "export const ignored = true\n")
    git(dir, ["mv", "packages/kilo-vscode/src/view.ts", "packages/kilo-vscode/src/renamed.ts"])
    git(dir, ["rm", "packages/kilo-vscode/src/deleted.ts"])
    git(dir, ["commit", "-qm", "rename and delete"])
    const result = run(dir, ["--worktree", "--base=upstream"])
    expect(result.out).toContain("rename destinations skipped 1")
    expect(result.out).toContain("deletion-only 1")
    expect(result.out).toContain("ignored 1")
  })
})

describe("read-only diagnostics", () => {
  it("committed default ignores uncommitted edits, then audits them after commit", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts"
    writeFileSync(path.join(dir, file), "export const view = 2\nexport const stable = true\n")
    const pending = run(dir, [])
    expect(pending.code).toBe(0)
    expect(pending.out).toContain("Summary: files audited 0;")
    expect(pending.out).not.toContain("[MISSING]")

    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "unannotated committed change"])
    const committed = run(dir, [])
    expect(committed.code).toBe(1)
    expect(committed.out).toContain("Candidate base ref: 'upstream/main'")
    expect(committed.out).toContain(`FAIL ${file} (0/1 lines covered)`)
    expect(committed.out).toContain("[MISSING] L1-L1 (1 uncovered line)")
    expect(committed.out).toContain("findings 1 (fatal)")
    expect(committed.out).not.toContain("[REDUNDANT]")
    expect(committed.out).not.toContain("[ERROR]")
  })

  it("default --worktree audits annotated and missing uncommitted edits", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts"
    writeFileSync(
      path.join(dir, file),
      "export const view = 2 // fork_change\nexport const stable = true\nexport const missing = 3\n",
    )
    const result = run(dir, ["--worktree"])
    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL ${file} (1/2 lines covered)`)
    expect(result.out).toContain("[MISSING] L3-L3 (1 uncovered line)")
    expect(result.out).toContain("findings 1 (fatal)")
    expect(result.out).not.toContain("[REDUNDANT]")
    expect(result.out).not.toContain("[ERROR]")
    expect(result.out).not.toContain("[WARNING]")
  })

  it("reports missing coverage when a local refactor removes a fork marker", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts"
    writeFileSync(path.join(dir, file), "export const view = 2 // fork_change\nexport const stable = true\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "commit annotated fork change"])
    writeFileSync(path.join(dir, file), "export const view = 2\nexport const stable = true\n")

    for (const args of [["--worktree"], ["--worktree", "--select=agent-local"]]) {
      const result = run(dir, args)
      expect(result.code).toBe(1)
      expect(result.out).toContain("Candidate base ref: 'upstream/main'")
      expect(result.out).toContain(`FAIL ${file} (0/1 lines covered)`)
      expect(result.out).toContain("[MISSING] L1-L1 (1 uncovered line)")
      expect(result.out).toContain("findings 1 (fatal)")
      expect(result.out).not.toContain("[REDUNDANT]")
      expect(result.out).not.toContain("[ERROR]")
      expect(result.out).not.toContain("[WARNING]")
      expect(result.out).not.toContain("[NESTED]")
      expect(result.out).not.toContain("[DETACHED_HEADER]")
      expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
    }
  })

  it("reports redundant coverage when a local refactor removes fork code", () => {
    const file = "packages/kilo-vscode/src/view.ts",
      base = "export const view = 1\nexport const stable = true\n",
      dir = fixture({ [file]: base })
    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 1\nexport const stable = true\nexport const local = 2\n// fork_change end\n",
    )
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "commit fork block with upstream context"])
    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 1\nexport const stable = true\n// fork_change end\n",
    )

    for (const args of [["--worktree"], ["--worktree", "--select=agent-local"]]) {
      const result = run(dir, args)
      expect(result.code).toBe(1)
      expect(result.out).toContain("Candidate base ref: 'upstream/main'")
      expect(result.out).toContain(`FAIL ${file} (0/0 lines covered)`)
      expect(result.out).toContain("[REDUNDANT] L1-L4")
      expect(result.out).toContain("findings 1 (fatal)")
      expect(result.out).not.toContain("[MISSING]")
      expect(result.out).not.toContain("[ERROR]")
      expect(result.out).not.toContain("[WARNING]")
      expect(result.out).not.toContain("[NESTED]")
      expect(result.out).not.toContain("[DETACHED_HEADER]")
      expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
    }
  })

  it("CURRENT BUG: --base=HEAD and --base=origin/main at HEAD report inherited artifacts", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts",
      created = "packages/kilo-vscode/src/created.ts"
    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 2\n// fork_change end\nexport const stable = true\n",
    )
    writeFileSync(path.join(dir, created), "// fork_change - new file\nexport const created = 1\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-qm", "commit annotated fork changes"])
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])

    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 2\n// fork_change end\nexport const stable = false\nexport const missing = 3\n",
    )
    writeFileSync(path.join(dir, created), "// fork_change - new file\nexport const created = 2\n")
    const upstream = run(dir, ["--worktree"])
    expect(upstream.code).toBe(1)
    expect(upstream.out).toContain("Candidate base ref: 'upstream/main'")
    expect(upstream.out).toContain(`FAIL ${file} (1/3 lines covered)`)
    expect(upstream.out).toContain("[MISSING] L4-L5 (2 uncovered lines)")
    expect(upstream.out).toContain(`PASS ${created} (1/1 lines covered)`)
    expect(upstream.out).toContain("findings 1 (fatal)")
    expect(upstream.out).not.toContain("[REDUNDANT]")
    expect(upstream.out).not.toContain("whole-file '- new file' marker used on an existing file")
    expect(upstream.out).not.toContain("[ERROR]")

    for (const base of ["HEAD", "origin/main"]) {
      const result = run(dir, ["--worktree", `--base=${base}`])
      const parts = result.out.split("\n\n"),
        view = parts.find((part) => part.startsWith(`FAIL ${file} `)) ?? "",
        fresh = parts.find((part) => part.startsWith(`FAIL ${created} `)) ?? ""
      expect(result.code).toBe(1)
      expect(result.out).toContain(`Candidate base ref: '${base}'`)
      expect(result.out).toContain(`FAIL ${file} (0/2 lines covered)`)
      expect(view).toContain("[REDUNDANT] L1-L3")
      expect(view).toContain("[MISSING] L4-L5 (2 uncovered lines)")
      expect(view).not.toContain("[ERROR]")
      expect(result.out).toContain(`FAIL ${created} (1/1 lines covered)`)
      expect(fresh).toContain("whole-file '- new file' marker used on an existing file")
      expect(fresh.split("[ERROR]").length - 1).toBe(1)
      expect(fresh).not.toContain("[MISSING]")
      expect(fresh).not.toContain("[REDUNDANT]")
      expect(result.out).toContain("findings 3 (fatal)")
      expect(result.out).not.toContain("[DETACHED_HEADER]")
      expect(result.out).not.toContain("[STRUCTURE_SPLIT]")
      expect(result.out).not.toContain("[NESTED]")
      expect(result.out).not.toContain("[WARNING]")
    }
  }, 30_000)

  it("--base=origin/main audits committed changes when origin/main is behind HEAD", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts",
      base = git(dir, ["rev-parse", "HEAD"]).trim()
    git(dir, ["update-ref", "refs/remotes/origin/main", base])
    writeFileSync(path.join(dir, file), "export const view = 2 // fork_change\nexport const stable = true\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "commit annotated change ahead of origin"])
    expect(git(dir, ["rev-parse", "HEAD"]).trim()).not.toBe(base)
    expect(git(dir, ["rev-parse", "origin/main"]).trim()).toBe(base)

    const result = run(dir, ["--base=origin/main"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("Candidate base ref: 'origin/main'")
    expect(result.out).toContain(`Resolved merge-base: '${base}'`)
    expect(result.out).toContain(`Scanning fork modifications against: ${base}...HEAD`)
    expect(result.out).toContain(`PASS ${file} (1/1 lines covered)`)
    expect(result.out).toContain("files audited 1;")
    expect(result.out).toContain("findings 0 (fatal)")
    expect(result.out).not.toContain("[MISSING]")
    expect(result.out).not.toContain("[REDUNDANT]")
    expect(result.out).not.toContain("[ERROR]")
  }, 30_000)

  it("validates headers on untracked --worktree files", () => {
    const dir = fixture(),
      valid = "packages/kilo-vscode/src/untracked-valid.ts",
      invalid = "packages/kilo-vscode/src/untracked-missing-header.ts"
    writeFileSync(path.join(dir, valid), "// fork_change - new file\nexport const valid = true\n")
    writeFileSync(path.join(dir, invalid), "export const invalid = true // fork_change\n")

    const result = run(dir, ["--worktree"])
    expect(result.code).toBe(1)
    expect(result.out).toContain(`PASS ${valid} (1/1 lines covered)`)
    expect(result.out).toContain(`FAIL ${invalid} (1/1 lines covered)`)
    expect(result.out).toContain("new file requires 'fork_change - new file' on its first non-shebang line")
    expect(result.out).toContain("files audited 2;")
    expect(result.out).toContain("findings 1 (fatal)")
    expect(result.out.split("[ERROR]").length - 1).toBe(1)
    expect(result.out).not.toContain("[MISSING]")
    expect(result.out).not.toContain("[REDUNDANT]")
    expect(result.out).not.toContain("[WARNING]")
  })

  it("agent-local selects staged, unstaged, and untracked paths against upstream only", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts",
      created = "packages/kilo-vscode/src/created.ts",
      branch = "packages/kilo-vscode/src/deleted.ts",
      local = "packages/kilo-vscode/src/agent-local.ts"
    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 2\n// fork_change end\nexport const stable = true\n",
    )
    writeFileSync(path.join(dir, created), "// fork_change - new file\nexport const created = 1\n")
    writeFileSync(path.join(dir, branch), "export const deleted = false\n")
    git(dir, ["add", "-A"])
    git(dir, ["commit", "-qm", "commit branch changes including a real gap"])

    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 3\n// fork_change end\nexport const stable = true\n",
    )
    git(dir, ["add", file])
    writeFileSync(path.join(dir, created), "// fork_change - new file\nexport const created = 2\n")
    writeFileSync(path.join(dir, local), "// fork_change - new file\nexport const local = true\n")

    const result = run(dir, ["--worktree", "--select=agent-local", "--base=upstream/main"])
    expect(result.out).not.toContain(branch)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`Candidate base ref: 'upstream/main'`)
    expect(result.out).toContain(`PASS ${file} (1/1 lines covered)`)
    expect(result.out).toContain(`PASS ${created} (1/1 lines covered)`)
    expect(result.out).toContain(`PASS ${local} (1/1 lines covered)`)
    expect(result.out).toContain("files audited 3;")
    expect(result.out).toContain("findings 0 (fatal)")
    expect(result.out).not.toContain("[MISSING]")
    expect(result.out).not.toContain("[REDUNDANT]")
    expect(result.out).not.toContain("whole-file '- new file' marker used on an existing file")
  })

  it("agent-local still rejects a real missing addition and a genuine redundant marker", () => {
    const red = "packages/kilo-vscode/src/redundant.ts",
      dir = fixture({ [red]: "export const stable = true\n" }),
      file = "packages/kilo-vscode/src/view.ts",
      branch = "packages/kilo-vscode/src/deleted.ts"
    writeFileSync(path.join(dir, branch), "export const deleted = false\n")
    git(dir, ["add", branch])
    git(dir, ["commit", "-qm", "commit unselected branch problem"])

    writeFileSync(
      path.join(dir, file),
      "export const view = 1\nexport const stable = true\nexport const localMissing = 1\n",
    )
    writeFileSync(
      path.join(dir, red),
      "// fork_change start\nexport const stable = true\n// fork_change end\nexport const local = 2 // fork_change\n",
    )
    const result = run(dir, ["--worktree", "--select=agent-local", "--base=upstream/main"])
    expect(result.out).not.toContain(branch)
    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL ${file} (0/1 lines covered)`)
    expect(result.out).toContain("[MISSING] L3-L3 (1 uncovered line)")
    expect(result.out).toContain(`FAIL ${red} (1/1 lines covered)`)
    expect(result.out).toContain("[REDUNDANT] L1-L3")
    expect(result.out).toContain("files audited 2;")
    expect(result.out).toContain("findings 2 (fatal)")
    expect(result.out).not.toContain("[ERROR]")
    expect(result.out).not.toContain("[WARNING]")
  })

  it("branch selects divergent HEAD-side commits and reads their worktree contents", () => {
    const origin = "packages/kilo-vscode/src/origin-only.ts",
      dir = fixture({ [origin]: "export const value = 1\n" }),
      base = git(dir, ["rev-parse", "HEAD"]).trim(),
      file = "packages/kilo-vscode/src/view.ts",
      created = "packages/kilo-vscode/src/created.ts",
      local = "packages/kilo-vscode/src/deleted.ts",
      fresh = "packages/kilo-vscode/src/local-untracked.ts"
    git(dir, ["checkout", "-qb", "origin-side"])
    writeFileSync(path.join(dir, origin), "export const value = 2\n")
    git(dir, ["add", origin])
    git(dir, ["commit", "-qm", "change origin-only path"])
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])
    git(dir, ["checkout", "-q", "main"])

    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 2\n// fork_change end\nexport const stable = true\n",
    )
    writeFileSync(path.join(dir, created), "// fork_change - new file\nexport const created = true\n")
    git(dir, ["add", file, created])
    git(dir, ["commit", "-qm", "commit HEAD-side changes"])
    expect(git(dir, ["merge-base", "HEAD", "origin/main"]).trim()).toBe(base)
    expect(git(dir, ["rev-parse", "HEAD"]).trim()).not.toBe(git(dir, ["rev-parse", "origin/main"]).trim())

    const committed = run(dir, ["--select=branch"])
    expect(committed.code).toBe(0)
    expect(committed.out).toContain(`PASS ${file} (1/1 lines covered)`)
    expect(committed.out).toContain(`PASS ${created} (1/1 lines covered)`)
    expect(committed.out).toContain("files audited 2;")
    expect(committed.out).not.toContain(origin)
    expect(committed.out).not.toContain("[MISSING]")

    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const view = 2\n// fork_change end\nexport const stable = true\nexport const localMissing = 1\n",
    )
    writeFileSync(path.join(dir, local), "export const localOnly = 1\n")
    writeFileSync(path.join(dir, fresh), "export const untrackedOnly = 1\n")
    const result = run(dir, ["--worktree", "--select=branch", "--base=upstream/main"])
    expect(result.out).not.toContain(origin)
    expect(result.out).not.toContain(local)
    expect(result.out).not.toContain(fresh)
    expect(result.code).toBe(1)
    expect(result.out).toContain(`Candidate base ref: 'upstream/main'`)
    expect(result.out).toContain(`FAIL ${file} (1/2 lines covered)`)
    expect(result.out).toContain("[MISSING] L5-L5 (1 uncovered line)")
    expect(result.out).toContain(`PASS ${created} (1/1 lines covered)`)
    expect(result.out).toContain("files audited 2;")
    expect(result.out).toContain("findings 1 (fatal)")
    expect(result.out).not.toContain("[REDUNDANT]")
    expect(result.out).not.toContain("whole-file '- new file' marker used on an existing file")
  })

  it("rejects agent-local without --worktree, missing origin/main, and unknown selectors", () => {
    const cases = [
      { args: ["--select=agent-local"], text: "--worktree" },
      { args: ["--worktree", "--select=branch"], text: "origin/main" },
      { args: ["--worktree", "--select=unknown"], text: "selector" },
    ]
    const output = cases.map((item) => {
      const result = run(fixture(), item.args)
      return {
        error: result.code !== 0,
        context: result.out.toLowerCase().includes(item.text.toLowerCase()),
        summary: result.out.includes("Summary:"),
        pass: result.out.includes("PASS "),
      }
    })
    expect(output).toEqual([
      { error: true, context: true, summary: false, pass: false },
      { error: true, context: true, summary: false, pass: false },
      { error: true, context: true, summary: false, pass: false },
    ])
  })

  it("focused audit: exempts a true cross-hunk move", () => {
    const dir = fixture({
      "packages/kilo-vscode/src/view.ts": "export const view = 1\nexport const moved = 2\nexport const stable = true\n",
    })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "export const view = 1\nexport const stable = true\n\nexport const moved = 2 // fork_change\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(0/0 lines covered)")
  })

  it("focused audit: exempts a legitimate multiline move over 100 lines including closers", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `const filler${i} = ${i}`).join("\n")
    const dir = fixture({
      "packages/kilo-vscode/src/view.ts": `const moved = build({\n  value: true,\n})\n${filler}\n`,
    })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      `${filler}\n// fork_change start\nconst moved = build({\n  value: true,\n})\n// fork_change end\n`,
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(0/0 lines covered)")
    expect(result.out).not.toContain("[MISSING]")
  })

  it("focused audit: does not consume a lone structural closer from an unrelated deleted block", () => {
    const filler = Array.from({ length: 100 }, (_, i) => `const filler${i} = ${i}`).join("\n")
    const dir = fixture({
      "packages/kilo-vscode/src/view.ts": `const old = thing(\n  oldValue,\n)\n${filler}\n`,
    })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      `${filler}\nconst next = thing( // fork_change\n  newValue, // fork_change\n) // fork_change\n`,
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(3/3 lines covered)")
  })

  it("focused audit: treats unrelated identical delete/add as an ambiguous move", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `export const filler${i} = ${i}`).join("\n")
    const dir = fixture({
      "packages/kilo-vscode/src/view.ts": `export const view = 1\n${filler}\nexport const stable = true\nexport const moved = 1\n`,
    })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      `export const view = 1\n${filler}\nexport const stable = true\nexport const moved = 1 // fork_change\n`,
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(0/0 lines covered)")
  })

  it("focused audit: one removal explains only one of two additions", () => {
    const dir = fixture({ "packages/kilo-vscode/src/view.ts": "export const moved = 1\n" })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "export const moved = 1 // fork_change\n  export const moved = 1\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[MISSING]")
    expect(result.out).toContain("(0/1 lines covered)")
  })

  it("focused audit: marker-only churn does not hide a real addition", () => {
    const dir = fixture({ "packages/kilo-vscode/src/view.ts": "export const stable = 1\n" })
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "export const stable = 1 // fork_change\nexport const real = 2\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[MISSING]")
    expect(result.out).toContain("(0/1 lines covered)")
  })

  it("focused churn: duplicate removal consumes only one addition", () => {
    expect(
      takeChurnMatches(
        [
          { line: 10, text: "const same = 1" },
          { line: 20, text: "const same = 1" },
        ],
        new Map([["const same = 1", 1]]),
      ),
    ).toEqual([10])
  })

  it("matches structure findings one-to-one by category, kind, and mapped anchors", () => {
    const split = (kind: string, startLine: number, endLine: number) => ({
      category: "STRUCTURE_SPLIT" as const,
      kind,
      startLine,
      endLine,
    })
    expect(
      matchFindings([split("FunctionDeclaration", 3, 7)], [split("FunctionDeclaration", 3, 7)], (line) => line),
    ).toEqual([])
    expect(
      matchFindings(
        [split("FunctionDeclaration", 3, 7), split("FunctionDeclaration", 3, 7)],
        [split("FunctionDeclaration", 3, 7)],
        (line) => line,
      ),
    ).toHaveLength(1)
    expect(
      matchFindings([split("FunctionDeclaration", 3, 7)], [split("ArrowFunction", 3, 7)], (line) => line),
    ).toHaveLength(1)
    expect(
      matchFindings([split("FunctionDeclaration", 3, 9)], [split("FunctionDeclaration", 3, 7)], (line) =>
        line === 9 ? undefined : line,
      ),
    ).toHaveLength(1)
  })

  it("focused audit: a copy while the original remains is not exempt", () => {
    const dir = fixture()
    const filler = Array.from({ length: 80 }, (_, i) => `export const filler${i} = ${i}`).join("\n")
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      `export const view = 1\n${filler}\nexport const stable = true\nexport const view = 1 // fork_change\n`,
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[MISSING]")
  })

  it("focused audit: same-family nesting and unbalanced blocks are hard", () => {
    const dir = fixture()
    const file = path.join(dir, "packages/kilo-vscode/src/view.ts")
    writeFileSync(
      file,
      "// fork_change start\n// fork_change start\nexport const view = 2\n// fork_change end\n// fork_change end\n",
    )
    const nested = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(nested.code).toBe(1)
    expect(nested.out).toContain("[NESTED]")
    writeFileSync(file, "// fork_change start\nexport const view = 2\n")
    const unbalanced = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(unbalanced.code).toBe(1)
    expect(unbalanced.out).toContain("unclosed 'fork_change start'")
  })

  it("focused audit: historical backend Kilo redundancy is non-hard", () => {
    const dir = fixture()
    const file = "packages/opencode/src/kilocode/history.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode"), { recursive: true })
    writeFileSync(path.join(dir, file), "export const history = 1\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "backend base"])
    writeFileSync(
      path.join(dir, file),
      "// kilocode_change start: historical\nexport const history = 1\n// kilocode_change end\n",
    )
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("[REDUNDANT]")
  })

  it("focused audit: existing-file whole-file headers follow marker severity", () => {
    const dir = fixture()
    const shared = "packages/opencode/src/shared.ts"
    const backend = "packages/opencode/src/kilocode/backend.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode"), { recursive: true })
    writeFileSync(path.join(dir, shared), "export const shared = 1\n")
    writeFileSync(path.join(dir, backend), "export const backend = 1\n")
    git(dir, ["add", shared, backend])
    git(dir, ["commit", "-qm", "zone bases"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(path.join(dir, shared), "// kilocode_change - new file\nexport const shared = 2\n")
    writeFileSync(path.join(dir, backend), "// fork_change - new file\nexport const backend = 2\n")
    const sharedResult = run(dir, ["--worktree", "--base=upstream", shared])
    const backendResult = run(dir, ["--worktree", "--base=upstream", backend])
    expect(sharedResult.code).toBe(0)
    expect(backendResult.code).toBe(1)
    expect(sharedResult.out).toContain("whole-file '- new file'")
    expect(backendResult.out).toContain("whole-file '- new file'")
  })

  it("focused audit: added fork file with an L1 whole-file header is clean", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/created.ts"
    writeFileSync(path.join(dir, file), "// fork_change - new file\nexport const created = true\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "add fork file"])
    const result = run(dir, ["--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(1/1 lines covered)")
    expect(result.out).not.toContain("[REDUNDANT]")
  })

  it("focused audit: shebang file with an L2 whole-file header is clean", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/created-cli.ts"
    writeFileSync(path.join(dir, file), "#!/usr/bin/env bun\n// fork_change - new file\nexport const created = true\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "add shebang fork file"])
    const result = run(dir, ["--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("(2/2 lines covered)")
    expect(result.out).not.toContain("[REDUNDANT]")
  })

  it("focused audit: merge-base Kilo whole-file header survives a content change", () => {
    const dir = fixture(),
      file = "packages/opencode/src/kilocode/provider/provider.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode/provider"), { recursive: true })
    writeFileSync(path.join(dir, file), "// kilocode_change - new file\nexport const provider = 1\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "historical kilo file"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(path.join(dir, file), "// kilocode_change - new file\nexport const provider = 2 // kilocode_change\n")
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("whole-file '- new file' marker used on an existing file")
    expect(result.out).not.toContain("[REDUNDANT]")
  })

  it("focused audit: historical acceptance is Kilo-only and first-line-only", () => {
    const dir = fixture(),
      forked = "packages/opencode/src/kilocode/forked.ts",
      late = "packages/opencode/src/kilocode/late.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode"), { recursive: true })
    writeFileSync(path.join(dir, forked), "// fork_change - new file\nexport const forked = 1\n")
    writeFileSync(
      path.join(dir, late),
      "export const marker = 1\n// kilocode_change - new file\nexport const late = 1\n",
    )
    git(dir, ["add", forked, late])
    git(dir, ["commit", "-qm", "provenance bases"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(path.join(dir, forked), "// fork_change - new file\nexport const forked = 2\n")
    writeFileSync(
      path.join(dir, late),
      "// kilocode_change - new file\nexport const marker = 2\nexport const late = 2\n",
    )
    const forkedResult = run(dir, ["--worktree", "--base=upstream", forked]),
      lateResult = run(dir, ["--worktree", "--base=upstream", late])
    expect(forkedResult.code).toBe(1)
    expect(lateResult.code).toBe(0)
    expect(forkedResult.out).toContain("whole-file '- new file' marker used on an existing file")
    expect(lateResult.out).toContain("whole-file '- new file' marker used on an existing file")
  })

  it("focused audit: newly added Kilo header on an existing backend file is advisory", () => {
    const dir = fixture(),
      file = "packages/opencode/src/kilocode/backend.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode"), { recursive: true })
    writeFileSync(path.join(dir, file), "export const backend = 1\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "backend base"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(path.join(dir, file), "// kilocode_change - new file\nexport const backend = 2\n")
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("whole-file '- new file' marker used on an existing file")
  })

  it("focused audit: genuine inline redundancy survives the whole-file exception", () => {
    const dir = fixture(),
      file = "packages/kilo-vscode/src/view.ts"
    writeFileSync(path.join(dir, file), "export const stable = 1 // fork_change\nexport const view = 1\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "inline marker base"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(path.join(dir, file), "export const stable = 1 // fork_change\nexport const view = 2\n")
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[REDUNDANT] L1-L1")
  })

  it("focused audit: modified historical Kilo header is advisory", () => {
    const dir = fixture(),
      rationalized = "packages/opencode/src/kilocode/rationalized.ts",
      restyled = "packages/opencode/src/kilocode/restyled.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode"), { recursive: true })
    writeFileSync(path.join(dir, rationalized), "// kilocode_change - new file\nexport const rationalized = 1\n")
    writeFileSync(path.join(dir, restyled), "// kilocode_change - new file\nexport const restyled = 1\n")
    git(dir, ["add", rationalized, restyled])
    git(dir, ["commit", "-qm", "historical headers"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(
      path.join(dir, rationalized),
      "// kilocode_change - new file: rationale\nexport const rationalized = 2\n",
    )
    writeFileSync(path.join(dir, restyled), "/* kilocode_change - new file */\nexport const restyled = 2\n")
    const rationalizedResult = run(dir, ["--worktree", "--base=upstream", rationalized]),
      restyledResult = run(dir, ["--worktree", "--base=upstream", restyled])
    expect(rationalizedResult.code).toBe(0)
    expect(restyledResult.code).toBe(0)
    expect(rationalizedResult.out).toContain("whole-file '- new file' marker used on an existing file")
    expect(restyledResult.out).toContain("whole-file '- new file' marker used on an existing file")
  })

  it("focused audit: historical header acceptance keeps unrelated diagnostics", () => {
    const dir = fixture(),
      file = "packages/opencode/src/kilocode/provider/legacy.ts"
    mkdirSync(path.join(dir, "packages/opencode/src/kilocode/provider"), { recursive: true })
    writeFileSync(path.join(dir, file), "// kilocode_change - new file\nexport const legacy = 1\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "historical legacy file"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(
      path.join(dir, file),
      "// kilocode_change - new file\n// fork_change start\nexport const legacy = 2\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("unclosed 'fork_change start'")
  })

  it("focused audit: structure split is hard on the actual audit path", () => {
    const dir = fixture()
    const file = "packages/kilo-vscode/src/object.ts"
    writeFileSync(path.join(dir, file), "export const value = {\n  stable: true\n}\n")
    git(dir, ["add", file])
    git(dir, ["commit", "-qm", "structure base"])
    git(dir, ["update-ref", "refs/remotes/upstream/main", "HEAD"])
    git(dir, ["branch", "-f", "upstream", "HEAD"])
    writeFileSync(
      path.join(dir, file),
      "// fork_change start\nexport const value = {\n// fork_change end\n  stable: true\n}\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[STRUCTURE_SPLIT]")
  })

  it("focused audit: summary counts successful audits", () => {
    const dir = fixture()
    writeFileSync(
      path.join(dir, "packages/kilo-vscode/src/view.ts"),
      "export const view = 2 // fork_change\nexport const stable = true\n",
    )
    const result = run(dir, ["--worktree", "--base=upstream", "packages/kilo-vscode/src/view.ts"])
    expect(result.code).toBe(0)
    expect(result.out).toContain("Summary: files audited 1;")
  })

  it("unions independent Kilo and Fork coverage in backend files", () => {
    const result = parseCoveredRanges(
      [
        "// kilocode_change start: why",
        "const kilo = 2",
        "// fork_change start: fork rationale",
        "const both = 3",
        "// kilocode_change end: why",
        "const fork = 4",
        "// fork_change end: fork rationale",
      ],
      "kilo_backend",
    )
    expect(result.errors).toEqual([])
    expect(result.markers).toHaveLength(2)
    expect(result.coveredLines).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]))
  })

  it("reports new-file header requirements", () => {
    expect(newFileHeaderError(["export const value = 1"], "shared_opencode")).toContain("kilocode_change - new file")
  })

  it("normalizes ownership without treating marker-only edits as fork changes", () => {
    expect(stripMarkerComments("const value = 1 // fork_change rationale")).toBe("const value = 1")
    expect([...matchChurnLines(["const value = 1 // fork_change"], ["const value = 1"])]).toEqual([0])
  })

  it("enforces the marker family for exclusive and shared zones", () => {
    const lines = ["// kilocode_change start", "const value = 2 // kilocode_change", "// kilocode_change end"]
    expect(parseCoveredRanges(lines, "kilo_backend").errors).toEqual([])
    expect(parseCoveredRanges(lines, "kilo_exclusive").errors.join("\n")).toContain("forbidden 'kilocode_change'")
    expect(parseCoveredRanges(lines, "shared_opencode").markers).toHaveLength(1)
  })

  it("reports inactive family and placement errors", () => {
    expect(
      parseCoveredRanges(["// fork_change start", "const value = 1", "// fork_change end"], "shared_opencode").errors,
    ).toHaveLength(2)
    expect(
      parseCoveredRanges(["/**", " * // kilocode_change start", " */"], "kilo_backend").errors.join("\n"),
    ).toContain("marker inside a block/JSDoc comment")
    expect(renderedMarkerLines(["  // kilocode_change start"], "kilo_backend")).toEqual([])
  })

  it("parses active same-line start/end markers and ignores inactive same-line markers", () => {
    const active = parseCoveredRanges(["const value = 1 /* fork_change start */ /* fork_change end */"], "kilo_backend")
    expect(active.errors).toEqual([])
    expect(active.markers).toEqual([{ type: "block", startLine: 1, endLine: 1, markerType: "fork" }])
    expect(
      parseCoveredRanges(["const value = 1 /* kilocode_change start */ /* kilocode_change end */"], "kilo_backend")
        .markers,
    ).toEqual([{ type: "block", startLine: 1, endLine: 1, markerType: "kilo" }])
  })

  it("rejects markers embedded in same-line block comments", () => {
    const result = parseCoveredRanges(["const value = 1 /* explanation: fork_change start */"], "kilo_backend")
    expect(result.errors.join("\n")).toContain("marker inside a block/JSDoc comment")
    expect(result.markers).toEqual([])
  })

  it("keeps churn matching inside one hunk and limits duplicate consumption", () => {
    expect([...matchChurnLines(["const same = 1 // fork_change"], ["const same = 1"])]).toEqual([0])
    expect([
      ...matchChurnLines(["const same = 1 // fork_change", "const same = 1 // fork_change"], ["const same = 1"]),
    ]).toEqual([0])
  })

  it("distinguishes real structure cuts from complete large constructs without a size threshold", () => {
    const source = parseAuditSource(
      "value.tsx",
      ["const value = {", "  changed: true,", "  stable: true", "}"].join("\n"),
    )!
    expect(structureCuts(source, 0, 2).length).toBeGreaterThan(0)
    const large = parseAuditSource(
      "value.ts",
      ["function large() {", ...Array.from({ length: 60 }, (_, i) => `  const value${i} = ${i}`), "}"].join("\n"),
    )!
    expect(structureCuts(large, 0, 63)).toEqual([])
  })

  it("reports a detached callable header but accepts a whole-function author block", () => {
    const source = parseAuditSource("value.ts", ["function value() {", "  return 1", "}"].join("\n"))!
    expect(detachedHeader(source, 1, 2)).toMatchObject({ kind: "FunctionDeclaration", line: 1 })
    expect(detachedHeader(source, 1, 4)).toBeNull()
  })

  it("classifies overwrap as advisory context, template, churn, or captured code", () => {
    const lines = ["// fork_change start", "const old = 1", "const text = `old", "more`", "}", "// fork_change end"]
    const result = classifyOverwrap([2, 3, 4, 5], new Set([5]), lines, templateSpans(lines), new Set([2]))
    expect(result.churnLines).toEqual([2])
    expect(result.templateLines).toEqual([3, 4])
    expect(result.meaningful).toBe(0)
  })
})

describe("severity policy", () => {
  it("reports new Kilo structural anomalies as visible non-fatal warnings", () => {
    const file = "packages/opencode/src/kilo-structure-severity.ts",
      source = "const items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\n",
      dir = fixture({ [file]: source })
    writeFileSync(path.join(dir, file), source.replace("const b = 2", "items.forEach((x) => {"))
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("[WARNING] [STRUCTURE_SPLIT]")
    expect(result.out).toContain("[WARNING] [DETACHED_HEADER]")
    expect(result.out).toContain("findings 0")
    expect(result.out).toContain("warnings 2")
  })

  it("reports new Kilo nesting as a visible non-fatal warning", () => {
    const file = "packages/opencode/src/kilo-nested-severity.ts",
      source = "// kilocode_change start\nexport const value = 1\n// kilocode_change end\n",
      dir = fixture({ [file]: source })
    writeFileSync(
      path.join(dir, file),
      source.replace("export const value = 1", "export const value = 1 // kilocode_change"),
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(0)
    expect(result.out).toContain("[WARNING] [NESTED]")
    expect(result.out).toContain("findings 0")
    expect(result.out).toContain("warnings 1")
  })

  it("keeps equivalent fork structural and nested anomalies fatal in Kilo-exclusive files", () => {
    const file = "packages/kilo-vscode/src/fork-severity.ts",
      base = "export const value = {\n  stable: true\n}\nexport const nested = 1\n",
      current =
        "// fork_change start\nexport const value = {\n  changed: true,\n// fork_change end\n  stable: true\n}\n// fork_change start\nexport const nested = 2 // fork_change\n// fork_change end\n",
      dir = fixture({ [file]: base })
    writeFileSync(path.join(dir, file), current)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[ERROR] [STRUCTURE_SPLIT]")
    expect(result.out).toContain("[ERROR] [NESTED]")
    expect(result.out).toContain("findings 2")
    expect(result.out).toContain("warnings 0")
  })

  it("counts only fork findings as fatal when Kilo and fork anomalies are mixed", () => {
    const file = "packages/opencode/src/kilocode/mixed-severity.ts",
      base =
        "export const nested = 1\nconst items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\n",
      current =
        "// fork_change start\nexport const nested = 1 // fork_change\n// fork_change end\nconst items = [1]\n// kilocode_change start\nitems.forEach((x) => {\n// kilocode_change end\n.map((x) => x)\n",
      dir = fixture({ [file]: base })
    writeFileSync(path.join(dir, file), current)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[WARNING] [STRUCTURE_SPLIT]")
    expect(result.out).toContain("[WARNING] [DETACHED_HEADER]")
    expect(result.out).toContain("[ERROR] [NESTED]")
    expect(result.out.split("[NESTED]").length - 1).toBe(1)
    expect(result.out).toContain("findings 1")
    expect(result.out).toContain("warnings 2")
  })

  it("treats one parser diagnostic involving both families as fatal", () => {
    const file = "packages/opencode/src/kilocode/mixed-parser-severity.ts",
      base = "/**\n *\n *\n */\nexport const value = 1\n",
      current =
        "/**\n * // kilocode_change start // fork_change\n * // kilocode_change end\n */\nexport const value = 1\n",
      dir = fixture({ [file]: base })
    writeFileSync(path.join(dir, file), current)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[ERROR] Line 2: marker inside a block/JSDoc comment")
    expect(result.out).toContain("[WARNING] Line 3: marker inside a block/JSDoc comment")
    expect(result.out).toContain("markers: kilocode_change, fork_change")
    expect(result.out).not.toContain("kilo_change")
    expect(result.out).toContain("findings 1")
    expect(result.out).toContain("warnings 1")
  })

  it("makes a mixed end-without-start diagnostic fatal and names both marker families", () => {
    const file = "packages/opencode/src/kilocode/mixed-end-severity.ts",
      base = "export const value = 1\n",
      current = "export const value = 1 // kilocode_change end // fork_change\n",
      dir = fixture({ [file]: base })
    writeFileSync(path.join(dir, file), current)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[ERROR] Line 1: 'kilocode_change end' without an active start block")
    expect(result.out).toContain("markers: kilocode_change, fork_change")
    expect(result.out).not.toContain("kilo_change")
    expect(result.out).toContain("findings 1")
  })

  it("keeps mixed unclosed markers fatal with both-family attribution", () => {
    const file = "packages/opencode/src/kilocode/mixed-unclosed-severity.ts",
      base = "export const value = 1\n",
      current = "// kilocode_change start // fork_change start\nexport const value = 2\n",
      dir = fixture({ [file]: base })
    writeFileSync(path.join(dir, file), current)
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("unclosed 'kilocode_change start'")
    expect(result.out).toContain("unclosed 'fork_change start'")
    expect(result.out).toContain("markers: kilocode_change, fork_change")
    expect(result.out).not.toContain("kilo_change")
    expect(result.out).toContain("findings 2")
    expect(result.out).toContain("warnings 0")
  })

  it("keeps mixed forbidden and placement diagnostics fatal", () => {
    const cases = [
      {
        file: "packages/opencode/src/mixed-forbidden-severity.ts",
        base: "export const value = 1\n",
        current: "export const value = 1 // kilocode_change // fork_change\n",
        text: "forbidden 'fork_change'",
      },
      {
        file: "packages/opencode/src/kilocode/mixed-placement-severity.ts",
        base: "export const value = 1 === 1\n",
        current: "export const value = 1 /* kilocode_change */ /* fork_change */ === 1\n",
        text: "marker has code after it",
      },
    ]
    for (const item of cases) {
      const dir = fixture({ [item.file]: item.base })
      writeFileSync(path.join(dir, item.file), item.current)
      const result = run(dir, ["--worktree", "--base=upstream", item.file])
      expect(result.code).toBe(1)
      expect(result.out).toContain(item.text)
      expect(result.out).toContain("markers: kilocode_change, fork_change")
      expect(result.out).not.toContain("kilo_change")
      expect(result.out).toContain("findings 1")
    }
  })

  it("keeps missing fork-owned lines fatal when Kilo warnings coexist", () => {
    const file = "packages/opencode/src/kilocode/missing-with-warning.ts",
      source = "const items = [1]\n// kilocode_change start\nconst b = 2\n// kilocode_change end\n.map((x) => x)\n",
      dir = fixture({ [file]: source })
    writeFileSync(
      path.join(dir, file),
      `${source.replace("const b = 2", "items.forEach((x) => {")}export const missing = 3\n`,
    )
    const result = run(dir, ["--worktree", "--base=upstream", file])
    expect(result.code).toBe(1)
    expect(result.out).toContain("[WARNING] [STRUCTURE_SPLIT]")
    expect(result.out).toContain("[WARNING] [DETACHED_HEADER]")
    expect(result.out).toContain("[MISSING]")
    expect(result.out).toContain("findings 1")
    expect(result.out).toContain("warnings 2")
  })

  it("assigns generic parser diagnostics to their marker family", () => {
    const cases = [
      {
        file: "packages/opencode/src/kilocode/unclosed-kilo.ts",
        base: "export const value = 1\n",
        current: "// kilocode_change start\nexport const value = 2\n",
        code: 0,
        label: "[WARNING]",
        text: "unclosed 'kilocode_change start'",
      },
      {
        file: "packages/kilo-vscode/src/unclosed-fork.ts",
        base: "export const value = 1\n",
        current: "// fork_change start\nexport const value = 2\n",
        code: 1,
        label: "[ERROR]",
        text: "unclosed 'fork_change start'",
      },
      {
        file: "packages/opencode/src/kilocode/end-kilo.ts",
        base: "export const value = 1\n",
        current: "export const value = 1 // kilocode_change end\n",
        code: 0,
        label: "[WARNING]",
        text: "'kilocode_change end' without an active start block",
      },
      {
        file: "packages/kilo-vscode/src/end-fork.ts",
        base: "export const value = 1\n",
        current: "export const value = 1 // fork_change end\n",
        code: 1,
        label: "[ERROR]",
        text: "'fork_change end' without an active start block",
      },
      {
        file: "packages/kilo-vscode/src/forbidden-kilo.ts",
        base: "export const value = 1\n",
        current: "export const value = 1 // kilocode_change\n",
        code: 0,
        label: "[WARNING]",
        text: "forbidden 'kilocode_change'",
      },
      {
        file: "packages/opencode/src/forbidden-fork.ts",
        base: "export const value = 1\n",
        current: "export const value = 1 // fork_change\n",
        code: 1,
        label: "[ERROR]",
        text: "forbidden 'fork_change'",
      },
      {
        file: "packages/opencode/src/kilocode/placement-kilo.ts",
        base: "export const value = 1 === 1\n",
        current: "export const value = 1 /* kilocode_change */ === 1\n",
        code: 0,
        label: "[WARNING]",
        text: "marker has code after it",
      },
      {
        file: "packages/kilo-vscode/src/placement-fork.ts",
        base: "export const value = 1 === 1\n",
        current: "export const value = 1 /* fork_change */ === 1\n",
        code: 1,
        label: "[ERROR]",
        text: "marker has code after it",
      },
    ]
    for (const item of cases) {
      const dir = fixture({ [item.file]: item.base })
      writeFileSync(path.join(dir, item.file), item.current)
      const result = run(dir, ["--worktree", "--base=upstream", item.file])
      expect(result.code).toBe(item.code)
      expect(result.out).toContain(item.label)
      expect(result.out).toContain(item.text)
      expect(result.out).not.toContain("kilo_change")
      expect(result.out).toContain(`findings ${item.code}`)
    }
  }, 30_000)
})
