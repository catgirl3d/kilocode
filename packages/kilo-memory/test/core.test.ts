import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Memory } from "../src/memory"
import { MemoryDigest } from "../src/capture/digest"
import { MemoryFiles } from "../src/storage/store"
import { MemoryIndexer } from "../src/recall/indexer"
import { MemoryOperations } from "../src/capture/operations"
import { MemoryPaths } from "../src/storage/paths"
import { MemoryRecall } from "../src/recall/recall"
import { MemorySchema } from "../src/schema"
import { KiloMemory } from "../src/effect/index"

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kilo-memory-"))
  return {
    dir,
    root: path.join(dir, "memory"),
    async done() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function use(fn: (input: Awaited<ReturnType<typeof tmp>>) => Promise<void>) {
  const t = await tmp()
  try {
    await fn(t)
  } finally {
    await t.done()
  }
}

describe("memory core package", () => {
  test("enable scaffolds state, source files, gitignore, and index", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const shown = await Memory.show({ root: t.root })

      expect(enabled.state.enabled).toBe(true)
      expect(shown.sources.project).toContain("# Project Memory")
      expect(shown.sources.environment).toContain("## Commands")
      expect(shown.sources.corrections).toContain("## Corrections")
      expect(await Bun.file(path.join(t.root, ".gitignore")).text()).toBe("*\n!.gitignore\n")
      expect(shown.index).toBe("")
      expect(shown.changes).toBe("")
      expect(shown.decisions).toBe("")
      expect(await Bun.file(path.join(t.root, "decisions.jsonl")).exists()).toBe(false)
    })
  })

  test("legacy audit compatibility APIs remain no-op", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.append(t.root, "provider error with sensitive detail")
      await MemoryFiles.decide(t.root, {
        kind: "typed",
        result: "error",
        reason: "provider error with sensitive detail",
      })

      expect(await MemoryFiles.readChanges(t.root)).toBe("")
      expect(await MemoryFiles.readDecisions(t.root)).toBe("")
      expect(await Bun.file(path.join(t.root, "decisions.jsonl")).exists()).toBe(false)
    })
  })

  test("prepare removes legacy decisions once from owned memory roots", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const legacy = path.join(t.root, "decisions.jsonl")
      await writeFile(legacy, '{"kind":"log"}\n')

      await KiloMemory.status({ root: t.root })
      expect(await Bun.file(legacy).exists()).toBe(false)

      await writeFile(legacy, '{"kind":"log"}\n')
      await KiloMemory.status({ root: t.root })
      expect(await Bun.file(legacy).exists()).toBe(true)

      const other = path.join(t.dir, "unowned")
      await mkdir(other)
      const file = path.join(other, "decisions.jsonl")
      await writeFile(file, '{"kind":"log"}\n')

      await KiloMemory.status({ root: other })
      expect(await Bun.file(file).exists()).toBe(true)
    })
  })

  test("prepare ignores legacy decisions cleanup failures", async () => {
    const clock = spyOn(Date, "now")
    const now = Date.now()
    clock.mockReturnValue(now)
    try {
      await use(async (t) => {
        await Memory.enable({ root: t.root })
        const legacy = path.join(t.root, "decisions.jsonl")
        await mkdir(legacy)

        const status = await KiloMemory.status({ root: t.root })
        expect(status.state.enabled).toBe(true)

        await rm(legacy, { recursive: true })
        await writeFile(legacy, '{"kind":"log"}\n')
        await KiloMemory.status({ root: t.root })
        expect(await Bun.file(legacy).exists()).toBe(true)

        clock.mockReturnValue(now + 60_001)
        await KiloMemory.status({ root: t.root })
        expect(await Bun.file(legacy).exists()).toBe(false)
      })
    } finally {
      clock.mockRestore()
    }
  })

  test("prepare ignores corrupt manifests during legacy cleanup", async () => {
    const clock = spyOn(Date, "now")
    const now = Date.now()
    clock.mockReturnValue(now)
    try {
      await use(async (t) => {
        await Memory.enable({ root: t.root })
        const paths = MemoryPaths.files(t.root)
        await writeFile(paths.manifest, "{")

        const status = await KiloMemory.status({ root: t.root })
        expect(status.state.enabled).toBe(true)

        await writeFile(paths.manifest, '{"kind":"kilo-memory","version":1}\n')
        await writeFile(paths.decisions, '{"kind":"log"}\n')
        await KiloMemory.status({ root: t.root })
        expect(await Bun.file(paths.decisions).exists()).toBe(true)

        clock.mockReturnValue(now + 60_001)
        await KiloMemory.status({ root: t.root })
        expect(await Bun.file(paths.decisions).exists()).toBe(false)
      })
    } finally {
      clock.mockRestore()
    }
  })

  test("legacy cleanup cache evicts older roots", async () => {
    await use(async (t) => {
      const first = path.join(t.dir, "cache-0")
      await mkdir(first)
      await MemoryFiles.writeManifest(first)
      await MemoryFiles.cleanup(first)
      const legacy = MemoryPaths.files(first).decisions
      await writeFile(legacy, '{"kind":"log"}\n')

      for (let i = 1; i <= 128; i++) {
        const root = path.join(t.dir, `cache-${i}`)
        await mkdir(root)
        await MemoryFiles.writeManifest(root)
        await MemoryFiles.cleanup(root)
      }

      await MemoryFiles.cleanup(first)
      expect(await Bun.file(legacy).exists()).toBe(false)
    })
  })

  test("enable preserves existing memory settings", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      await MemoryFiles.writeState(t.root, {
        ...enabled.state,
        autoInject: false,
        autoConsolidate: false,
        verbose: true,
      })

      const next = await Memory.enable({ root: t.root })

      expect(next.state.autoInject).toBe(true)
      expect(next.state.autoConsolidate).toBe(false)
      expect(next.state.verbose).toBe(true)
    })
  })

  test("state parser migrates legacy fields, ignores persisted limits, and rejects non-finite stats", () => {
    const paused = MemorySchema.parse({ autoInject: false })
    const missing = MemorySchema.missing()
    const state = MemorySchema.parse({
      limits: { maxSessionFiles: 50, maxRecentSessions: 10, maxSessionLineChars: 160, maxProjectIndexBytes: 1 },
      stats: {
        lastInjectedAt: Number.NaN,
        lastTypedConsolidationAt: Number.POSITIVE_INFINITY,
        lastSessionSavedAt: Number.POSITIVE_INFINITY,
      },
    })

    expect(paused.autoInject).toBe(true)
    expect(paused.autoConsolidate).toBe(true)
    expect(paused.verbose).toBe(false)
    expect(missing.enabled).toBe(false)
    expect(missing.autoConsolidate).toBe(true)
    expect(missing.verbose).toBe(false)
    expect(state.limits.maxSessionFiles).toBe(20)
    expect(state.limits.maxRecentSessions).toBe(5)
    expect(state.limits.maxProjectIndexBytes).toBe(8192)
    expect(state.limits.maxSessionLineChars).toBe(480)
    expect(state.stats.lastInjectedAt).toBeNull()
    expect(state.stats.lastTypedConsolidationAt).toBeNull()
    expect(state.stats.lastSessionSavedAt).toBeNull()
  })

  test("state writes omit code-owned limits", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })

      const raw = JSON.parse(await Bun.file(MemoryPaths.files(t.root).state).text())
      const state = await MemoryFiles.readState(t.root)

      expect(raw.limits).toBeUndefined()
      expect(raw.verbose).toBe(false)
      expect(state.limits.maxSessionLineChars).toBe(480)
    })
  })

  test("configures and persists verbose memory details", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const result = await Memory.configure({ root: t.root, settings: { verbose: true } })
      const raw = JSON.parse(await Bun.file(MemoryPaths.files(t.root).state).text())

      expect(result.state.verbose).toBe(true)
      expect(raw.verbose).toBe(true)
      expect((await MemoryFiles.readState(t.root)).verbose).toBe(true)
    })
  })

  test("stale locks are stolen before applying memory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const lock = path.join(t.root, ".lock")
      const old = new Date(Date.now() - 60_000)
      await mkdir(lock)
      await utimes(lock, old, old)

      await Memory.apply({ root: t.root, ops: [{ action: "add", key: "after_lock", text: "Stale locks recover." }] })
      const shown = await Memory.show({ root: t.root })

      expect(shown.sources.project).toContain("after_lock")
    })
  })

  test("corrupted state recovers disabled with derived inventory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await writeFile(MemoryPaths.files(t.root).state, "{", "utf8")

      const state = await MemoryFiles.readState(t.root)
      const files = await readdir(t.root)
      const shown = await Memory.show({ root: t.root })

      expect(state.enabled).toBe(false)
      expect(files.some((file) => file.startsWith("state.json.bad-"))).toBe(true)
      expect(shown.inventory.items).toEqual({})
    })
  })

  test("rejects symlinked memory roots", async () => {
    await use(async (t) => {
      const target = path.join(t.dir, "target")
      const link = path.join(t.dir, "link")
      await Memory.enable({ root: target })
      await symlink(target, link)

      await expect(Memory.enable({ root: link })).rejects.toThrow("memory path rejects symlink")
    })
  })

  test("uses unicode-safe project and memory identifiers", async () => {
    await use(async (t) => {
      const dir = path.join(t.dir, "proyecto_ñ_日本")
      await mkdir(dir)
      const id = MemoryPaths.identity({ ctx: { directory: dir, worktree: dir } })
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        key: "設定_é",
        text: "日本語の設定は packages/kilo-vscode に保存します。",
      })
      const shown = await Memory.show({ root: t.root })

      expect(id.display).toBe("proyecto_ñ_日本")
      expect(id.folder).toContain("proyecto_ñ_日本-")
      expect(shown.sources.project).toContain("- 設定_é :: 日本語の設定は packages/kilo-vscode に保存します。")
      expect(shown.items).toContain("id=project.md:Facts:設定_é")
    })
  })

  test("resolves memory roots under host data storage", async () => {
    await use(async (t) => {
      const project = path.join(t.dir, "repo")
      const data = path.join(t.dir, "data")
      await mkdir(project)

      const root = MemoryPaths.root({
        ctx: { directory: project, worktree: project },
        data,
      })

      expect(path.dirname(root)).toBe(path.join(data, "memory"))
      expect(path.basename(root)).toMatch(/^repo-[a-f0-9]{12}$/)
    })
  })

  test("does not trust workspace-controlled gitdir pointers for project identity", async () => {
    await use(async (t) => {
      const victim = path.join(t.dir, "victim")
      const other = path.join(t.dir, "other")
      await mkdir(path.join(other, ".git"), { recursive: true })
      await mkdir(victim)
      await writeFile(path.join(victim, ".git"), "gitdir: ../other/.git\n")

      const id = MemoryPaths.identity({ ctx: { directory: victim, worktree: victim } })

      expect(path.basename(id.canonical)).toBe("victim")
      expect(path.basename(id.canonical)).not.toBe("other")
      expect(id.folder.startsWith("victim-")).toBe(true)
    })
  })

  test("serializes concurrent operations for one root", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const ops: MemoryOperations.Op[] = [
        { action: "add", key: "one", text: "first durable fact" },
        { action: "add", key: "two", text: "second durable fact" },
      ]

      await Promise.all(ops.map((op) => Memory.apply({ root: t.root, ops: [op] })))
      const shown = await Memory.show({ root: t.root })

      expect(shown.sources.project).toContain("- one :: first durable fact")
      expect(shown.sources.project).toContain("- two :: second durable fact")
    })
  })

  test("apply upserts, removes, dedupes, and skips secrets without aborting the batch", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "repo_tests", text: "Run CLI memory tests from packages/opencode." },
          { action: "add", key: "repo_tests_copy", text: "Run CLI memory tests from packages/opencode." },
          { action: "remove", query: "repo_tests" },
          { action: "add", key: "repo_tests", text: "Run CLI memory tests from packages/opencode." },
        ],
      })
      // A secret-like op is skipped (recorded), not thrown, so the sibling clean op still applies.
      const mixed = await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "bad", text: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
          { action: "add", key: "safe_fact", text: "Memory ops keep applying past a secret op." },
        ],
      })
      const shown = await Memory.show({ root: t.root })

      expect(mixed.result.added).toBe(1)
      expect(mixed.result.skipped).toContainEqual({ reason: "secret", text: "[redacted]" })
      expect(JSON.stringify(mixed.result.skipped)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
      expect(shown.sources.project).toContain("safe_fact")
      expect(shown.sources.project).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
      expect(shown.sources.project.match(/repo_tests/g)?.length).toBe(1)
      expect(shown.index).toContain("repo_tests")
    })
  })

  test("automatic apply does not remove memory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [{ action: "add", key: "durable_fact", text: "This durable fact must survive auto capture." }],
      })

      const result = await Memory.apply({
        root: t.root,
        trigger: "turn-close",
        ops: [{ action: "remove", query: "durable_fact" }],
      })
      const shown = await Memory.show({ root: t.root })

      expect(result.result.operationCount).toBe(0)
      expect(result.result.removed).toBe(0)
      expect(shown.sources.project).toContain("durable_fact")
      expect(shown.index).toContain("durable_fact")
    })
  })

  test("apply drops self-referential memory facts", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })

      const result = await Memory.apply({
        root: t.root,
        ops: [
          {
            action: "add",
            key: "memory_echo",
            text: "Small model call-site behavior is already captured in project memory.",
          },
        ],
      })
      const shown = await Memory.show({ root: t.root })

      expect(result.result.operationCount).toBe(0)
      expect(result.result.added).toBe(0)
      expect(result.result.skipped).toEqual([
        { reason: "self_referential", text: "Small model call-site behavior is already captured in project memory." },
      ])
      expect(shown.sources.project).not.toContain("memory_echo")
      expect(shown.index).not.toContain("memory_echo")
    })
  })

  test("apply drops personal preference facts but keeps project facts", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })

      const blocked = await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "reply_style", text: "I prefer terse summaries." },
          { action: "add", key: "theme", text: "My preference is dark mode." },
          { action: "add", key: "editor", text: "User prefers Vim keybindings." },
        ],
      })
      const saved = await Memory.apply({
        root: t.root,
        ops: [{ action: "add", key: "repo_style", text: "Repo convention: commit messages are concise." }],
      })
      const shown = await Memory.show({ root: t.root })

      expect(blocked.result.operationCount).toBe(0)
      expect(blocked.result.added).toBe(0)
      expect(blocked.result.skipped).toEqual([
        { reason: "out_of_scope", text: "I prefer terse summaries." },
        { reason: "out_of_scope", text: "My preference is dark mode." },
        { reason: "out_of_scope", text: "User prefers Vim keybindings." },
      ])
      expect(saved.result.operationCount).toBe(1)
      expect(saved.result.added).toBe(1)
      expect(shown.sources.project).toContain("- repo_style :: Repo convention: commit messages are concise.")
      expect(shown.sources.project).not.toContain("reply_style")
      expect(shown.sources.project).not.toContain("dark mode")
      expect(shown.sources.project).not.toContain("Vim keybindings")
      expect(shown.index).toContain("repo_style")
      expect(shown.index).not.toContain("reply_style")
    })
  })

  test("out-of-scope secret ops stay out of memory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })

      const result = await Memory.apply({
        root: t.root,
        ops: [{ action: "add", key: "private_pref", text: "My preference is password=hunter2." }],
      })
      const shown = await Memory.show({ root: t.root })

      expect(result.result.skipped).toEqual([{ reason: "out_of_scope", text: "My preference is [redacted]" }])
      expect(shown.sources.project).not.toContain("private_pref")
      expect(shown.sources.project).not.toContain("password=hunter2")
    })
  })

  test("normalizes unsafe memory keys", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [{ action: "add", key: " Run root tests?! ", text: "Use package-level tests instead." }],
      })
      const shown = await Memory.show({ root: t.root })

      expect(shown.sources.project).toContain("- run_root_tests :: Use package-level tests instead.")
    })
  })

  test("sanitizes explicit sections before writing source files", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const long = "x".repeat(120)
      await Memory.apply({
        root: t.root,
        ops: [
          {
            action: "add",
            key: "newline_section",
            section: "Notes\n## Injected\n- fake :: value",
            text: "Keep malformed section text inside one safe heading.",
          },
          {
            action: "add",
            key: "hash_section",
            section: "## Decisions",
            text: "Leading hash markers become a plain heading.",
          },
          {
            action: "add",
            key: "separator_section",
            section: "Custom :: Entry",
            text: "Entry separators are not preserved in section names.",
          },
          {
            action: "add",
            key: "dash_section",
            section: "- Bullet",
            text: "Leading list markers become a plain heading.",
          },
          {
            action: "add",
            key: "long_section",
            section: long,
            text: "Long section names are capped.",
          },
          {
            action: "add",
            file: "environment.md",
            key: "empty_section",
            section: "###",
            text: "Empty section names fall back to the file default.",
          },
        ],
      })

      const shown = await Memory.show({ root: t.root })
      const inventory = await MemoryFiles.deriveInventory(t.root)
      const recall = await MemoryRecall.search({ root: t.root, query: "malformed section safe heading" })

      expect(shown.sources.project).toContain("## Notes ## Injected - fake value")
      expect(shown.sources.project).toContain("## Decisions")
      expect(shown.sources.project).toContain("## Custom Entry")
      expect(shown.sources.project).toContain("## Bullet")
      expect(shown.sources.project).toContain(`## ${"x".repeat(80)}`)
      expect(shown.sources.project).not.toContain(`## ${"x".repeat(81)}`)
      expect(shown.sources.project).not.toContain("\n## Injected\n")
      expect(shown.sources.project).not.toContain("\n- fake :: value\n")
      expect(shown.sources.environment).toContain("## Commands")
      expect(Object.values(inventory.items).some((item) => item.key === "fake")).toBe(false)
      expect(Object.values(inventory.items).filter((item) => item.key.endsWith("_section")).length).toBe(6)
      expect(recall?.block).toContain("newline_section")
    })
  })

  test("targeted recall returns typed memory and matched files", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        key: "cli_tests",
        text: "Run CLI tests from packages/opencode with bun test.",
      })

      const result = await Memory.recall({ root: t.root, query: "what command runs cli tests?" })
      expect(result.result?.block).toContain("cli_tests")
      expect(result.files).toEqual(["environment.md"])
    })
  })

  test("remember and correct persist normalized text beyond the 240-character preview", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        key: "long_fact",
        text: `  ${"project detail  ".repeat(26)}\n  REMEMBER_TAIL ::  after delimiter  `,
      })
      await Memory.correct({
        root: t.root,
        key: "long_correction",
        text: `\n  ${"review guidance  ".repeat(15)}\n  CORRECT_TAIL ::  after delimiter  \n`,
      })

      const project = await MemoryFiles.readSource(t.root, "project.md")
      const corrections = await MemoryFiles.readSource(t.root, "corrections.md")
      const index = await MemoryFiles.readIndex(t.root)
      const found = await Memory.recall({ root: t.root, query: "long_fact" })
      const hit = found.hits.find((item) => item.text.startsWith("long_fact :: "))

      expect(project.split("\n")).toContain(
        `- long_fact :: ${"project detail ".repeat(26)}REMEMBER_TAIL :: after delimiter`,
      )
      expect(corrections.split("\n")).toContain(
        `- long_correction :: ${"review guidance ".repeat(15)}CORRECT_TAIL :: after delimiter`,
      )
      expect(hit?.text.slice("long_fact :: ".length)).toHaveLength(350)
      expect(hit?.text).not.toContain("REMEMBER_TAIL")
      expect(index).toContain(`text: long_fact :: ${"project detail ".repeat(15)}project deta...`)
      expect(index).not.toContain("REMEMBER_TAIL")
    })
  })

  test("keeps different long tails under distinct keys when their shared prefix exceeds 240 characters", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const prefix = "sharedprefix".repeat(22)
      const first = `${prefix} alpha amber quartz violet cedar`
      const second = `${prefix} bravo basalt copper silver granite`

      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "first_long_tail", text: first },
          { action: "add", key: "second_long_tail", text: second },
        ],
      })
      const lines = (await MemoryFiles.readSource(t.root, "project.md")).split("\n")

      expect(prefix.length).toBeGreaterThan(240)
      expect(lines.some((line) => line.startsWith("- first_long_tail :: "))).toBe(true)
      expect(lines.some((line) => line.startsWith("- second_long_tail :: "))).toBe(true)
      expect(lines).toContain(`- first_long_tail :: ${first}`)
      expect(lines).toContain(`- second_long_tail :: ${second}`)
    })
  })

  test("typed and search recall find tail-only terms and expose canonical memory ids", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = `${"common material detail ".repeat(20)}TAIL_QUASAR`
      await Memory.remember({ root: t.root, key: "tail_entry", text })

      const typed = await MemoryRecall.search({ root: t.root, query: "quasar", mode: "typed" })
      const search = await MemoryRecall.search({ root: t.root, query: "quasar", mode: "search" })
      const index = await MemoryFiles.readIndex(t.root)
      const preview = index.match(/text: tail_entry :: ([^\n]+)/)?.[1]

      for (const result of [typed, search]) {
        const hit = result?.hits.at(0)
        expect(hit).toBeDefined()
        expect(hit?.memory_id).toBe("project.md:Facts:tail_entry")
        expect(hit?.text.startsWith("tail_entry :: ")).toBe(true)
        expect(hit?.text.slice("tail_entry :: ".length)).toHaveLength(350)
        expect(hit?.text).not.toContain("TAIL_QUASAR")
        expect(result?.block).toContain("memory_id=project.md:Facts:tail_entry")
      }
      expect(preview).toHaveLength(240)
      expect(preview).not.toContain("TAIL_QUASAR")
    })
  })

  test("filters ubiquitous query terms found only beyond typed previews", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const prefix = "filler ".repeat(51)
      const quartz = `${prefix}nebula quartz`
      const common = `${prefix}nebula`
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "## Facts",
          `- quartz_record :: ${quartz}`,
          `- first_common :: ${common}`,
          `- second_common :: ${common}`,
        ].join("\n"),
      )

      const result = await MemoryRecall.search({ root: t.root, query: "nebula quartz" })

      expect(result?.bytes).toBeLessThan(2000)
      expect(result?.hits.map((hit) => hit.memory_id)).toEqual(["project.md:Facts:quartz_record"])
      const read = await MemoryRecall.read({ root: t.root, recordID: result?.hits.at(0)?.memory_id ?? "" })
      expect(read.status).toBe("found")
      if (read.status === "found") expect(read.text).toBe(quartz)
    })
  })

  test("typed and search recall fit multiple complete long records within the default response budget", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const prefix = `${"a".repeat(250)}${"界".repeat(100)}`
      const keys = ["long_entry_alpha", "long_entry_bravo"]
      await Memory.apply({
        root: t.root,
        ops: keys.map((key, idx) => ({ action: "add" as const, key, text: `${prefix} ${idx} NEBULA` })),
      })

      for (const mode of ["typed", "search"] as const) {
        const result = await MemoryRecall.search({ root: t.root, query: "nebula", mode })
        const records = result?.block.match(/record [^\n]*\ntext: [^\n]*/g) ?? []

        expect(result?.bytes).toBeLessThanOrEqual(2000)
        expect(records).toHaveLength(2)
        for (const key of keys) {
          const record = records.find((item) => item.includes(`memory_id=project.md:Facts:${key}`))
          expect(record).toBeDefined()
          const idx = keys.indexOf(key)
          expect(record).toContain(`\ntext: ${key} :: ${prefix} ${idx} NEBULA`)
          expect(record).toContain("content=full")
        }
      }
    })
  })

  test("typed recall returns a complete long body when the full card fits", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = `${"Project continuity detail ".repeat(18)}FIT_TAIL_QUASAR`
      await Memory.remember({ root: t.root, key: "fitting_fact", text })

      const result = await MemoryRecall.search({ root: t.root, query: "quasar", mode: "typed" })
      const hit = result?.hits.at(0)

      expect(result?.block).toContain("record content=full id=")
      expect(result?.block).toContain("memory_id=project.md:Facts:fitting_fact")
      expect(result?.block).toContain(`text: fitting_fact :: ${text}`)
      expect(result?.block).toContain("FIT_TAIL_QUASAR")
      expect(hit).not.toHaveProperty("full")
      expect(hit).not.toHaveProperty("searchText")
      expect(result?.bytes).toBe(Buffer.byteLength(result?.block ?? ""))
      expect(result?.bytes).toBeLessThanOrEqual(2000)
    })
  })

  test("typed recall marks oversized bodies partial and keeps them exactly readable", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = `${"Partial record detail ".repeat(90)}PARTIAL_TAIL_QUASAR`
      await Memory.remember({ root: t.root, key: "oversized_fact", text })

      const result = await MemoryRecall.search({ root: t.root, query: "quasar", mode: "typed", maxBytes: 1000 })
      const hit = result?.hits.at(0)
      const read = await MemoryRecall.read({ root: t.root, recordID: hit?.memory_id ?? "" })

      expect(result?.block).toContain("record content=partial id=")
      expect(result?.block).toContain("memory_id=project.md:Facts:oversized_fact")
      expect(hit?.text.slice("oversized_fact :: ".length)).toHaveLength(350)
      expect(result?.block).toContain(`text: ${hit?.text}`)
      expect(result?.block).not.toContain("PARTIAL_TAIL_QUASAR")
      expect(read.status).toBe("found")
      if (read.status === "found") expect(read.text).toBe(text)
    })
  })

  test("typed recall marks short bodies full without changing their text", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = "Short current fact QUASAR"
      await Memory.remember({ root: t.root, key: "short_fact", text })

      const result = await MemoryRecall.search({ root: t.root, query: "quasar", mode: "typed" })

      expect(result?.block).toContain("record content=full id=")
      expect(result?.block).toContain("memory_id=project.md:Facts:short_fact")
      expect(result?.block).toContain(`text: short_fact :: ${text}`)
    })
  })

  test("typed full-body upgrades honor exact UTF-8 byte boundaries", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = `${"Русский текст для границы бюджета ".repeat(24)}BYTE_BOUNDARY_QUASAR`
      await Memory.remember({ root: t.root, key: "utf8_boundary", text })
      const input = { root: t.root, query: "quasar", mode: "typed" as const }
      const initial = await MemoryRecall.search(input)
      const hit = initial?.hits.at(0)
      const full = (initial?.block ?? "")
        .replace("record id=", "record content=full id=")
        .replace(`text: ${hit?.text}`, `text: utf8_boundary :: ${text}`)
      const exactBytes = Buffer.byteLength(full)
      const exact = await MemoryRecall.search({ ...input, maxBytes: exactBytes })
      const over = await MemoryRecall.search({ ...input, maxBytes: exactBytes - 1 })

      expect(exactBytes).toBeGreaterThan(full.length)
      expect(exact?.block).toContain("record content=full id=")
      expect(exact?.block).toContain("memory_id=project.md:Facts:utf8_boundary")
      expect(exact?.block).toContain(`text: utf8_boundary :: ${text}`)
      expect(exact?.bytes).toBe(exactBytes)
      expect(over?.block).toContain("record content=partial id=")
      expect(over?.block).toContain("memory_id=project.md:Facts:utf8_boundary")
      expect(over?.block).not.toContain("BYTE_BOUNDARY_QUASAR")
      expect(over?.bytes).toBeLessThanOrEqual(exactBytes - 1)
    })
  })

  test("a long first hit cannot evict another selected hit during full-body upgrades", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const long = `${"Long continuity detail ".repeat(68)}FIRST_QUASAR_PRIORITY_TAIL`
      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "aaa_long_first", text: long },
          { action: "add", key: "bbb_short_second", text: "Short QUASAR fact." },
        ],
      })

      const result = await MemoryRecall.search({ root: t.root, query: "quasar priority", limit: 2 })

      expect(result?.block).toContain("record content=partial id=")
      expect(result?.block).toContain("record content=full id=")
      expect(result?.block).toContain("memory_id=project.md:Facts:aaa_long_first")
      expect(result?.block).toContain("memory_id=project.md:Facts:bbb_short_second")
      expect(result?.hits.map((hit) => hit.memory_id)).toEqual([
        "project.md:Facts:aaa_long_first",
        "project.md:Facts:bbb_short_second",
      ])
      expect(result?.bytes).toBeLessThanOrEqual(2000)
    })
  })

  test("typed recall keeps the existing omitted-results note when cards are dropped", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const terms = ["quartz", "nebula", "tulip", "cobalt", "spruce", "violet"]
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        ["# Project Memory", "## Facts", ...terms.map((term, idx) => `- entry_${idx} :: ${term} saved detail.`)].join(
          "\n",
        ),
      )

      const result = await MemoryRecall.search({
        root: t.root,
        query: terms.join(" "),
        mode: "typed",
        limit: 10,
        maxBytes: 1024,
      })

      expect(result?.hits).toHaveLength(6)
      expect(result?.block).toContain(
        "note: index truncated; call kilo_memory_recall mode=typed|digest|search query=<topic> to search omitted memory",
      )
      expect((result?.block.match(/^record /gm) ?? []).length).toBeLessThan(result?.hits.length ?? 0)
      expect(result?.bytes).toBeLessThanOrEqual(1024)
    })
  })

  test("typed recall keeps the omitted-results note when rejecting a long-card upgrade", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const long = `${"Long continuity detail ".repeat(80)}QUASAR priority FULL_UPGRADE_TAIL`
      const terms = ["quartz", "nebula", "tulip", "cobalt", "spruce", "violet"]
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "## Facts",
          `- aaa_long_first :: ${long}`,
          "- bbb_short_second :: Short QUASAR priority fact.",
          ...terms.map((term, idx) => `- entry_${idx} :: ${term} saved detail.`),
        ].join("\n"),
      )

      const result = await MemoryRecall.search({
        root: t.root,
        query: "quasar priority quartz nebula tulip cobalt spruce violet",
        mode: "typed",
        limit: 10,
        maxBytes: 1024,
      })
      const cards = result?.block.match(/^record [^\n]*\ntext: [^\n]*/gm) ?? []
      const ids = cards.map((card) => card.match(/memory_id=([^\s]+)/)?.[1])
      const longCard = cards.at(0) ?? ""
      const shortCard = cards.at(1) ?? ""

      expect(result?.hits.map((hit) => hit.memory_id)).toEqual([
        "project.md:Facts:aaa_long_first",
        "project.md:Facts:bbb_short_second",
        "project.md:Facts:entry_0",
        "project.md:Facts:entry_1",
        "project.md:Facts:entry_2",
        "project.md:Facts:entry_3",
        "project.md:Facts:entry_4",
        "project.md:Facts:entry_5",
      ])
      expect(ids).toEqual(["project.md:Facts:aaa_long_first", "project.md:Facts:bbb_short_second"])
      expect(result?.block).toContain(
        "note: index truncated; call kilo_memory_recall mode=typed|digest|search query=<topic> to search omitted memory",
      )
      expect(longCard).toContain("record content=partial id=")
      expect(longCard).not.toContain("FULL_UPGRADE_TAIL")
      expect(shortCard).toContain("record content=full id=")
      expect(shortCard).toContain("text: bbb_short_second :: Short QUASAR priority fact.")
      expect(cards.length).toBeLessThan(result?.hits.length ?? 0)
      expect(result?.bytes).toBeLessThanOrEqual(1024)
    })
  })

  test("exact read accepts dot-only keys emitted by typed search", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        ["# Project Memory", "## Facts", "- .. :: distinctive value", "- . :: period marker"].join("\n"),
      )

      for (const item of [
        { key: "..", query: "distinctive", text: "distinctive value" },
        { key: ".", query: "marker", text: "period marker" },
      ]) {
        const found = await MemoryRecall.search({ root: t.root, query: item.query, mode: "typed" })
        const hit = found?.hits.find((entry) => entry.text.startsWith(`${item.key} :: `))
        expect(hit?.memory_id).toBe(`project.md:Facts:${item.key}`)

        const read = await MemoryRecall.read({ root: t.root, recordID: hit?.memory_id ?? "" })
        expect(read.status).toBe("found")
        if (read.status === "found") expect(read.text).toBe(item.text)
      }
    })
  })

  test("exact read returns current full content for matching file and section identity", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "## Facts",
          `- shared :: ${"Project detail ".repeat(24)}初回の保存✓`,
          "## Decisions",
          "- shared :: Project decision content.",
        ].join("\n"),
      )
      await MemoryFiles.writeSource(
        t.root,
        "environment.md",
        ["# Environment", "## Commands", "- shared :: Environment command content."].join("\n"),
      )

      const fact = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:shared" })
      const decision = await MemoryRecall.read({ root: t.root, recordID: "project.md:Decisions:shared" })
      const command = await MemoryRecall.read({ root: t.root, recordID: "environment.md:Commands:shared" })
      const updated = `${"Current material ".repeat(24)}最新の保存✓`
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "## Facts",
          `- shared :: ${updated}`,
          "## Decisions",
          "- shared :: Project decision content.",
        ].join("\n"),
      )
      const current = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:shared" })

      expect(fact.status).toBe("found")
      expect(fact.text).toBe(`${"Project detail ".repeat(24)}初回の保存✓`)
      expect(fact.text.length).toBeGreaterThan(240)
      expect(decision.status).toBe("found")
      expect(decision.text).toBe("Project decision content.")
      expect(command.status).toBe("found")
      expect(command.text).toBe("Environment command content.")
      expect(current.status).toBe("found")
      expect(current.text).toBe(updated)
    })
  })

  test("exact read preserves text as parsed from a manually edited source", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const text = "External   formatting\tis retained"
      await MemoryFiles.writeSource(t.root, "project.md", `# Project Memory\n## Facts\n- manual_edit :: ${text}`)

      const result = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:manual_edit" })

      expect(result.status).toBe("found")
      expect(result.text).toBe(text)
    })
  })

  test("exact read rejects malformed path selectors and does not fuzzy-fallback stale ids", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        "# Project Memory\n## Facts\n- stable_record :: Current entry.\n",
      )

      const malformed = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:../stable_record" })
      const stale = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:stable" })

      expect(malformed.status).toBe("invalid")
      expect(stale.status).toBe("not_found")
    })
  })

  test("exact read reports canonical-id collisions as ambiguous", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "## Facts!",
          `- duplicate :: ${"界".repeat(14_000)}`,
          "## Facts?",
          "- duplicate :: Second entry.",
        ].join("\n"),
      )

      const result = await MemoryRecall.read({ root: t.root, recordID: "project.md:Facts:duplicate" })

      expect(result.status).toBe("ambiguous")
      expect(result.matches).toBe(2)
    })
  })

  test("targeted recall uses source recency as a tiebreaker", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "older_docs",
            text: "Memory docs describe older recall ranking.",
          },
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "newer_docs",
            text: "Memory docs describe current recall ranking.",
          },
        ],
      })

      const result = await MemoryRecall.search({ root: t.root, query: "memory docs recall ranking", limit: 1 })

      expect(result?.block).toContain("newer_docs")
      expect(result?.block).not.toContain("older_docs")
    })
  })

  test("derived inventory timestamps are source-mtime ranking hints", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "",
          "## Facts",
          "- first_hint :: First derived timestamp hint.",
          "- second_hint :: Second derived timestamp hint.",
          "",
        ].join("\n"),
      )
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
      await utimes(MemoryPaths.source(t.root, "project.md"), stamp, stamp)

      const inventory = await MemoryFiles.deriveInventory(t.root)
      const shown = await Memory.show({ root: t.root })
      const first =
        inventory.items[MemoryFiles.inventoryKey({ file: "project.md", section: "Facts", key: "first_hint" })]!
      const second =
        inventory.items[MemoryFiles.inventoryKey({ file: "project.md", section: "Facts", key: "second_hint" })]!

      expect(first.createdAt).toBe(first.updatedAt)
      expect(second.createdAt).toBe(second.updatedAt)
      expect(first.createdAt).toBeGreaterThan(second.createdAt)
      expect(first.createdAt - second.createdAt).toBe(1)
      expect(shown.items).toContain("timeSource=source_mtime_line_offset")
    })
  })

  test("targeted recall dedupes lower-value session hits when typed memory answers", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        key: "memory_tests",
        text: "Run memory tests from packages/opencode with bun test ./test/kilocode/memory.",
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_memory_tests",
        summary: "Discussed running memory tests from packages/opencode.",
        time: Date.UTC(2026, 0, 1),
      })

      const result = await MemoryRecall.search({ root: t.root, query: "memory tests packages/opencode", limit: 5 })

      expect(result?.block).toContain("memory_tests")
      expect(result?.block).not.toContain("ses_memory_tests")
    })
  })

  test("digest recall honors requested sessions and ignores the active session", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_plan_memory",
        topic: "plan memory",
        summary: "Discussed token accounting for memory injection.",
        time: Date.UTC(2026, 0, 1),
      })

      const active = await MemoryRecall.search({
        root: t.root,
        query: "token accounting",
        mode: "digest",
        sessionID: "ses_plan_memory",
        currentSessionID: "ses_plan_memory",
      })
      const prior = await MemoryRecall.search({
        root: t.root,
        query: "token accounting",
        mode: "digest",
        sessionID: "ses_plan_memory",
        currentSessionID: "other",
      })

      expect(active).toBeUndefined()
      expect(prior?.block).toContain("session=ses_plan_memory")
      expect(prior?.block).toContain("token accounting")
    })
  })

  test("direct digest recall returns full stored summaries while the index stays brief", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const tail = "FULL_DETAIL_AFTER_480"
      const summary = `Long digest start. ${"continuity detail ".repeat(45)}${tail}`
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_full_digest",
        topic: "full digest",
        summary,
        time: Date.UTC(2026, 0, 1),
      })

      const saved = await MemoryFiles.readSession(t.root, {
        sessionID: "ses_full_digest",
        max: MemorySchema.maxStoredDigestSummary,
      })
      const shown = await Memory.show({ root: t.root })
      const recalled = await MemoryRecall.search({
        root: t.root,
        query: "",
        mode: "digest",
        sessionID: "ses_full_digest",
      })
      const latest = shown.index.match(/type=latest_session_digest[^\n]*\ntext: ([^\n]+)/)?.[1] ?? ""
      const brief = latest.split(":: ").slice(1).join(":: ")

      expect(saved?.summary.length).toBeGreaterThan(480)
      expect(saved?.summary).toContain(tail)
      expect(brief.length).toBeLessThanOrEqual(480)
      expect(recalled?.block).toContain(tail)
      expect(recalled?.block.length).toBeGreaterThan(480)
      expect(recalled?.block).not.toContain("content=")
    })
  })

  test("blank stored topic re-derives from User-prefixed summaries without splitting on colon", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await mkdir(MemoryPaths.files(t.root).sessions, { recursive: true })
      await writeFile(
        path.join(MemoryPaths.files(t.root).sessions, "2026-01-01T00-00-00.000Z_ses_topic_id.md"),
        [
          "# Session ses_topic",
          "",
          "Version: 1",
          "Updated: 2026-01-01T00:00:00.000Z",
          "Topic: ",
          "",
          "## Summary",
          "User: x Result: y. Next: continue.",
          "",
        ].join("\n"),
      )

      const saved = await MemoryFiles.readSession(t.root, { sessionID: "ses_topic", max: 480 })

      expect(saved?.topic).not.toBe("User")
      expect(saved?.topic).toContain("User: x Result: y")
    })
  })

  test("non-English stored text remains searchable", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", key: "pruebas_cli", text: "Ejecuta las pruebas CLI desde packages/opencode." },
          { action: "add", key: "memoire", text: "Les corrections de mémoire restent dans corrections.md." },
          { action: "add", key: "設定", text: "日本語の設定は packages/kilo-vscode に保存します。" },
        ],
      })

      const spanish = await MemoryRecall.search({ root: t.root, query: "pruebas CLI" })
      const french = await MemoryRecall.search({ root: t.root, query: "corrections mémoire" })
      const japanese = await MemoryRecall.search({ root: t.root, query: "日本語 設定" })

      expect(spanish?.block).toContain("pruebas_cli")
      expect(french?.block).toContain("memoire")
      expect(japanese?.block).toContain("設定")
    })
  })

  test("index caps preserve priority records under tight budgets", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const state = {
        ...enabled.state,
        limits: {
          ...enabled.state.limits,
          maxProjectIndexBytes: 700,
        },
      }
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "",
          "## Facts",
          ...Array.from({ length: 20 }, (_, idx) => `- fact_${idx} :: ${"x".repeat(40)}`),
          "",
          "## Decisions",
          "- architecture_choice :: Keep memory v0 file-based before adding databases.",
          "",
          "## Constraints",
          "- project_only :: Memory v0 must stay project-only.",
          "",
        ].join("\n"),
      )

      const index = await MemoryIndexer.rebuild({ root: t.root, state })

      expect(index.truncated).toBe(true)
      expect(index.text).toContain("type=project_decision")
      expect(index.text).toContain("architecture_choice")
      expect(index.text).toContain("type=project_constraint")
      expect(index.text).toContain("project_only")
    })
  })

  test("index reserves decisions and constraints against bulk correction pressure", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const state = {
        ...enabled.state,
        limits: {
          ...enabled.state.limits,
          maxProjectIndexBytes: 640,
        },
      }
      await MemoryFiles.writeSource(
        t.root,
        "corrections.md",
        [
          "# Corrective Memory",
          "",
          "## Corrections",
          ...Array.from(
            { length: 10 },
            (_, idx) =>
              `- correction_${idx} :: Reviewer correction ${idx} keeps ${"long guidance ".repeat(4)}visible in the index.`,
          ),
          "",
        ].join("\n"),
      )
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "",
          "## Decisions",
          "- architecture_choice :: Keep memory v0 file-based before adding databases.",
          "",
          "## Constraints",
          "- project_only :: Memory v0 must stay project-only.",
          "",
        ].join("\n"),
      )

      const index = await MemoryIndexer.rebuild({ root: t.root, state })

      expect(index.truncated).toBe(true)
      expect(index.text).toContain("architecture_choice")
      expect(index.text).toContain("project_only")
    })
  })

  test("index keeps recent session digests and recognizes stale formats", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      for (let idx = 0; idx < 12; idx++) {
        await Memory.recordSession({
          root: t.root,
          sessionID: `ses_${idx}`,
          summary: `summary_${String(idx).padStart(2, "0")} durable result`,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }
      const shown = await Memory.show({ root: t.root })

      expect(shown.index.match(/type=latest_session_digest/g)?.length).toBe(1)
      expect(shown.index.match(/type=session_digest/g)?.length).toBe(4)
      expect(shown.index).toContain("session=ses_11")
      expect(shown.index).toContain("session=ses_7")
      expect(shown.index).not.toContain("session=ses_6")
      expect(shown.index).toContain("type=latest_session_digest")
      expect(shown.index).not.toContain("summary_01 durable result")
      expect(MemoryIndexer.stale(shown.index)).toBe(false)
      expect(MemoryIndexer.stale("record id=session.ses type=session_digest source=ses.md")).toBe(true)
    })
  })

  test("index renders the latest session digest fuller than older digests", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      const older =
        `Older digest starts. ${"older continuity detail ".repeat(14)}` +
        "OLDER_DETAIL_AFTER_RECENT_CAP should be hidden from recent digest rendering."
      const latest =
        `Latest digest starts. ${"latest continuity detail ".repeat(14)}` +
        "LATEST_DETAIL_AFTER_RECENT_CAP should remain visible in the newest digest."
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_older_rich",
        topic: "Older Rich Digest",
        summary: older,
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_latest_rich",
        topic: "Latest Rich Digest",
        summary: latest,
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const shown = await Memory.show({ root: t.root })
      const newest = shown.index.match(/type=latest_session_digest[^\n]*\ntext: ([^\n]+)/)?.[1] ?? ""
      const recent = shown.index.match(/type=session_digest[^\n]*\ntext: ([^\n]+)/)?.[1] ?? ""

      expect(newest).toContain("session=ses_latest_rich")
      expect(newest).toContain("LATEST_DETAIL_AFTER_RECENT_CAP")
      expect(recent).toContain("session=ses_older_rich")
      expect(recent).not.toContain("OLDER_DETAIL_AFTER_RECENT_CAP")
      expect(newest.length).toBeGreaterThan(recent.length)
    })
  })

  test("index renders short session digests without padding", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_short",
        topic: "Short Digest",
        summary: "Short digest remains exact.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const shown = await Memory.show({ root: t.root })

      expect(shown.index).toContain("session=ses_short")
      expect(shown.index).toContain("Short digest remains exact.")
      expect(shown.index).not.toContain("Short digest remains exact. ")
      expect(shown.index).not.toContain("Short digest remains exact...")
    })
  })

  test("richer digest rendering stays inside the index budget and preserves priority records", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await MemoryFiles.writeSource(
        t.root,
        "corrections.md",
        [
          "# Corrective Memory",
          "",
          "## Corrections",
          "- reviewer_correction :: Always keep reviewer-requested memory corrections visible.",
          "",
        ].join("\n"),
      )
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "",
          "## Decisions",
          "- architecture_choice :: Keep memory v0 file-based before adding databases.",
          "",
          "## Constraints",
          "- project_only :: Memory v0 must stay project-only.",
          "",
          "## Facts",
          ...Array.from({ length: 120 }, (_, idx) => `- fact_${idx} :: ${"low priority fact ".repeat(8)}${idx}`),
          "",
        ].join("\n"),
      )
      for (let idx = 0; idx < 5; idx++) {
        await Memory.recordSession({
          root: t.root,
          sessionID: `ses_rich_${idx}`,
          topic: `Rich Digest ${idx}`,
          summary: `Rich digest ${idx}. ${"continuity detail ".repeat(30)}tail_${idx}.`,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }

      const index = await MemoryIndexer.rebuild({ root: t.root })

      expect(index.bytes).toBeLessThanOrEqual(8192)
      expect(index.text).toContain("reviewer_correction")
      expect(index.text).toContain("architecture_choice")
      expect(index.text).toContain("project_only")
      expect(index.text).toContain("session=ses_rich_4")
    })
  })

  test("index preserves top durable facts before older session digest pressure", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const state = {
        ...enabled.state,
        limits: {
          ...enabled.state.limits,
          maxSessionFiles: 30,
          maxRecentSessions: 30,
          maxSessionLineChars: 1200,
        },
      }
      await Memory.apply({
        root: t.root,
        ops: [
          {
            action: "add",
            key: "fixture_palette_uses_teal",
            text: "The fixture palette uses teal and amber accents.",
          },
        ],
      })
      for (let idx = 0; idx < 30; idx++) {
        const latest = idx === 29
        await MemoryFiles.writeSession(t.root, {
          sessionID: `ses_budget_${String(idx).padStart(2, "0")}`,
          topic: latest ? "Latest Fixture Continuity" : `Older Fixture Digest ${idx}`,
          summary: latest
            ? `Latest digest starts. ${"latest continuity detail ".repeat(32)}LATEST_FIXTURE_BUDGET_END_SENTINEL`
            : `Older digest ${idx}. ${"older continuity detail ".repeat(60)}older_tail_${idx}.`,
          max: state.limits.maxSessionLineChars,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }

      const index = await MemoryIndexer.rebuild({ root: t.root, state })
      const saved = await MemoryFiles.readIndex(t.root)

      expect(index.bytes).toBeLessThanOrEqual(8192)
      expect(index.truncated).toBe(true)
      expect(saved).toBe(index.text)
      expect(saved).toContain("type=latest_session_digest")
      expect(saved).toContain("session=ses_budget_29")
      expect(saved).toContain("LATEST_FIXTURE_BUDGET_END_SENTINEL")
      expect(saved).toContain("teal and amber")
      expect(saved).toContain("mode=typed")
      expect(saved).not.toContain("mode=catalog")
      expect(saved).not.toContain("session=ses_budget_00")
    })
  })

  test("index caps covered session pointer ids", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const state = {
        ...enabled.state,
        limits: {
          ...enabled.state.limits,
          maxProjectIndexBytes: 100_000,
          maxSessionFiles: 50,
          maxRecentSessions: 50,
        },
      }
      await MemoryFiles.writeSource(
        t.root,
        "project.md",
        [
          "# Project Memory",
          "",
          "## Facts",
          ...Array.from(
            { length: 40 },
            (_, idx) => `- covered_${idx} :: Covered Session ${idx} facts are stored in typed memory.`,
          ),
          "",
        ].join("\n"),
      )
      for (let idx = 0; idx < 40; idx++) {
        await MemoryFiles.writeSession(t.root, {
          sessionID: `ses_covered_${idx}`,
          topic: `Covered Session ${idx}`,
          summary: `Covered Session ${idx} summary is already typed.`,
          max: state.limits.maxSessionLineChars,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }

      const index = await MemoryIndexer.rebuild({ root: t.root, state })
      const row = index.text.split("\n").find((line) => line.includes("covered by typed memory")) ?? ""

      expect(row.match(/session=ses_covered_/g)).toHaveLength(32)
    })
  })

  test("index preserves top environment commands before older session digest pressure", async () => {
    await use(async (t) => {
      const enabled = await Memory.enable({ root: t.root })
      const state = {
        ...enabled.state,
        limits: {
          ...enabled.state.limits,
          maxSessionFiles: 30,
          maxRecentSessions: 30,
          maxSessionLineChars: 1200,
        },
      }
      await MemoryFiles.writeSource(
        t.root,
        "environment.md",
        [
          "# Environment Memory",
          "",
          "## Commands",
          "- sdk_regen :: Run SDK regeneration from repo root with ./script/generate.ts.",
          "- vscode_unit_tests :: Run VS Code memory unit tests from packages/kilo-vscode with bun test tests/unit/memory-command.test.ts.",
          ...Array.from(
            { length: 40 },
            (_, idx) =>
              `- env_tail_${idx} :: Environment command ${idx} stays reachable through recall catalog when the startup index is full.`,
          ),
          "",
        ].join("\n"),
      )
      for (let idx = 0; idx < 30; idx++) {
        const latest = idx === 29
        await MemoryFiles.writeSession(t.root, {
          sessionID: `ses_env_budget_${String(idx).padStart(2, "0")}`,
          topic: latest ? "Latest Environment Continuity" : `Older Environment Digest ${idx}`,
          summary: latest
            ? `Latest digest starts. ${"latest environment continuity ".repeat(32)}LATEST_ENV_BUDGET_END_SENTINEL`
            : `Older environment digest ${idx}. ${"older environment continuity ".repeat(60)}older_env_tail_${idx}.`,
          max: state.limits.maxSessionLineChars,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }

      const index = await MemoryIndexer.rebuild({ root: t.root, state })
      const saved = await MemoryFiles.readIndex(t.root)

      expect(index.bytes).toBeLessThanOrEqual(8192)
      expect(index.truncated).toBe(true)
      expect(saved).toBe(index.text)
      expect(saved).toContain("type=latest_session_digest")
      expect(saved).toContain("session=ses_env_budget_29")
      expect(saved).toContain("LATEST_ENV_BUDGET_END_SENTINEL")
      expect(saved).toContain("Run SDK regeneration from repo root")
      expect(saved).toContain("VS Code memory unit tests")
      expect(saved).not.toContain("session=ses_env_budget_00")
    })
  })

  test("session digest files prune to the current default limit", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      for (let idx = 0; idx < 25; idx++) {
        await Memory.recordSession({
          root: t.root,
          sessionID: `ses_${idx}`,
          summary: `summary_${String(idx).padStart(2, "0")} durable result`,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })
      }

      const files = (await readdir(MemoryPaths.files(t.root).sessions)).filter((file) => file.endsWith(".md"))

      expect(files).toHaveLength(20)
      expect(files.some((file) => file.includes("_ses_24_id_"))).toBe(true)
      expect(files.some((file) => file.includes("_ses_4_id_"))).toBe(false)
    })
  })

  test("index dedupes bulk recent session digests by normalized topic", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_shared_old",
        topic: "Shared Topic",
        summary: "Older shared-topic work.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_distinct",
        topic: "Distinct Topic",
        summary: "Distinct recent work.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_shared_new",
        topic: " shared   topic ",
        summary: "Newer shared-topic work.",
        time: Date.UTC(2026, 0, 1, 0, 2),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_latest",
        topic: "Latest Topic",
        summary: "Newest continuity pointer.",
        time: Date.UTC(2026, 0, 1, 0, 3),
      })

      const shown = await Memory.show({ root: t.root })

      expect(shown.index.match(/type=latest_session_digest/g)?.length).toBe(1)
      expect(shown.index).toContain("session=ses_latest")
      expect(shown.index).toContain("session=ses_shared_new")
      expect(shown.index).toContain("session=ses_distinct")
      expect(shown.index).not.toContain("session=ses_shared_old")
    })
  })

  test("index suppresses bulk session digests covered by typed memory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "small_model_call_sites",
            text: "Small model call sites are selected in the OpenCode adapter during memory capture.",
          },
        ],
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_small_model",
        topic: "Small model call sites",
        summary: "Small model call sites are selected in the OpenCode adapter during memory capture.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_latest",
        topic: "Digest prompt polish",
        summary: "Objective: polish digest prompts. Next: verify latest session remains injected.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const shown = await Memory.show({ root: t.root })

      expect(shown.index).toContain("small_model_call_sites")
      expect(shown.index).toContain("session=ses_latest")
      // The bulky SESSION_DIGEST record for the covered session is dropped from the index body...
      expect(shown.index).not.toContain("source=ses_small_model.md")
      // ...but a compact pointer keeps its id targetable via kilo_memory_recall mode=digest.
      expect(shown.index).toContain("covered_session_pointer")
      expect(shown.index).toContain("session=ses_small_model")
    })
  })

  test("index keeps the true newest continuation-style session", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_substantive",
        summary: "Objective: finish memory continuity. Next: verify startup index ordering.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_empty_newest",
        summary: "Continue requested; no substantive work was done.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const shown = await Memory.show({ root: t.root })

      expect(MemoryDigest.empty("Continue requested; no substantive work was done.")).toBe(false)
      expect(shown.index.match(/type=latest_session_digest/g)?.length).toBe(1)
      expect(shown.index).toContain("type=latest_session_digest")
      expect(shown.index).toContain("session=ses_empty_newest")
      expect(shown.index.indexOf("session=ses_empty_newest")).toBeLessThan(
        shown.index.indexOf("session=ses_substantive"),
      )
    })
  })

  test("index keeps older non-empty continuation-style digests", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_old_empty",
        summary: "Continue requested; no substantive work was done.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_latest",
        summary: "Objective: implement continuity. Next: keep latest session visible.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const shown = await Memory.show({ root: t.root })

      expect(shown.index.match(/type=latest_session_digest/g)?.length).toBe(1)
      expect(shown.index).toContain("type=latest_session_digest")
      expect(shown.index).toContain("session=ses_latest")
      expect(shown.index).not.toMatch(/type=session_digest[^\n]*\ntext: session=ses_latest/)
      expect(shown.index).toContain("session=ses_old_empty")
    })
  })

  test("index surfaces non-English newest sessions as latest digests", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_older",
        summary: "Objective: older memory work. Next: continue old validation.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await Memory.recordSession({
        root: t.root,
        sessionID: "ses_es",
        topic: "continuidad",
        summary: "Objetivo: revisar continuidad de memoria. Siguiente: verificar la etiqueta mas reciente.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const shown = await Memory.show({ root: t.root })

      expect(shown.index.match(/type=latest_session_digest/g)?.length).toBe(1)
      expect(shown.index).toContain("session=ses_es")
      expect(shown.index).toContain("continuidad")
    })
  })

  test("session digest classifier is structural only", () => {
    expect(
      MemoryDigest.empty({
        file: "2026.md",
        id: "ses",
        time: "2026-01-01T00:00:00.000Z",
        topic: "Memory Updates",
        summary:
          "Recent state: Latest commit: e83a920622 feat(cli): add project memory v0. Working tree has untracked .plans and memory docs. Last saved focus: memory v0 behavior.",
      }),
    ).toBe(false)
    expect(MemoryDigest.empty("")).toBe(true)
    expect(MemoryDigest.empty({ topic: "", summary: " " })).toBe(true)
    expect(MemoryDigest.empty({ topic: "continuidad", summary: " " })).toBe(false)
    expect(MemoryDigest.empty("User: continue")).toBe(false)
    expect(MemoryDigest.empty("Continue requested; no substantive work was done.")).toBe(false)
    expect(MemoryDigest.empty("Objective: implement recall. Next: wire prompt injection.")).toBe(false)
  })

  test("purge rejects directories not owned by memory", async () => {
    await use(async (t) => {
      await mkdir(t.root)
      const file = path.join(t.root, "keep.txt")
      await writeFile(file, "keep")

      await expect(Memory.purge({ root: t.root })).rejects.toThrow("unowned memory root")
      expect(await Bun.file(file).text()).toBe("keep")
    })
  })

  test("qualified forget removes only the selected record", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", file: "project.md", section: "Facts", key: "tests", text: "Project tests" },
          { action: "add", file: "environment.md", section: "Commands", key: "tests", text: "bun test" },
        ],
      })

      const result = await Memory.forget({ root: t.root, query: "project.md:Facts:tests" })
      const shown = await Memory.show({ root: t.root })

      expect(result.result.removed).toBe(1)
      expect(result.detail).toMatchObject({ type: "saved", added: 0, removed: 1 })
      expect(shown.sources.project).not.toContain("Project tests")
      expect(shown.sources.environment).toContain("bun test")
    })
  })

  test("same key can exist in separate sections", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.apply({
        root: t.root,
        ops: [
          { action: "add", file: "project.md", section: "Facts", key: "runtime", text: "Bun runs the project" },
          { action: "add", file: "project.md", section: "Decisions", key: "runtime", text: "Keep Bun for v1" },
        ],
      })

      const shown = await Memory.show({ root: t.root })
      expect(shown.sources.project).toContain("Bun runs the project")
      expect(shown.sources.project).toContain("Keep Bun for v1")
    })
  })

  test("failed session replacement preserves the prior digest", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({ root: t.root, sessionID: "same", summary: "valid", time: 1 })

      await expect(
        Memory.recordSession({ root: t.root, sessionID: "same", summary: "replacement", time: Number.NaN }),
      ).rejects.toThrow("finite")
      const prior = await MemoryFiles.readSession(t.root, { sessionID: "same", max: 480 })
      expect(prior?.summary).toBe("valid")
    })
  })

  test("deleted source and session files expire the index", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.remember({ root: t.root, key: "tests", text: "Run package tests" })
      await rm(MemoryPaths.files(t.root).project)
      expect(await MemoryFiles.indexExpired(t.root)).toBe(true)

      await Memory.enable({ root: t.root })
      await Memory.recordSession({ root: t.root, sessionID: "session", summary: "Session summary", time: 1 })
      const files = await readdir(MemoryPaths.files(t.root).sessions)
      await rm(path.join(MemoryPaths.files(t.root).sessions, files[0]!))
      await utimes(MemoryPaths.files(t.root).sessions, 0, 0)
      expect(await MemoryFiles.indexExpired(t.root)).toBe(true)
    })
  })

  test("empty recall queries do not return unrelated memory", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await Memory.remember({ root: t.root, key: "tests", text: "Run package tests" })

      expect(await MemoryRecall.search({ root: t.root, query: "!!!", force: true })).toBeUndefined()
    })
  })

  test("unsupported state versions recover disabled", async () => {
    await use(async (t) => {
      await Memory.enable({ root: t.root })
      await writeFile(MemoryPaths.files(t.root).state, JSON.stringify({ version: 2, enabled: true }))

      const state = await MemoryFiles.readState(t.root)
      const files = await readdir(t.root)
      expect(state.enabled).toBe(false)
      expect(files.some((file) => file.startsWith("state.json.bad-"))).toBe(true)
    })
  })
})
