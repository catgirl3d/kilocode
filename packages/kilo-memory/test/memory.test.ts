import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, symlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Memory } from "../src/memory"
import { MemoryPaths } from "../src/storage/paths"
import { MemoryRecall } from "../src/recall/recall"

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

describe("memory facade", () => {
  test("enables, writes, indexes, and recalls project memory", async () => {
    const t = await tmp()
    try {
      const enabled = await Memory.enable({ root: t.root })
      const status = await Memory.status({ root: t.root })

      expect(enabled.state.enabled).toBe(true)
      expect(status.exists.state).toBe(true)
      expect(status.exists.index).toBe(true)

      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        text: "Run CLI tests from packages/opencode.",
      })

      const ctx = await Memory.context({ root: t.root, record: false })
      const recall = await Memory.recall({ root: t.root, query: "CLI tests packages opencode" })

      expect(ctx.blocks[0]?.text).toContain("packages/opencode")
      expect(recall.result?.block).toContain("packages/opencode")
    } finally {
      await t.done()
    }
  })

  test("keeps Unicode keys and non-English text searchable", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        key: "設定",
        text: "日本語の設定は packages/kilo-vscode に保存します。",
      })

      const shown = await Memory.show({ root: t.root })
      const recall = await Memory.recall({ root: t.root, query: "日本語 設定 kilo-vscode" })

      expect(shown.sources.project).toContain("設定")
      expect(recall.result?.block).toContain("日本語")
    } finally {
      await t.done()
    }
  })

  test("correct replaces its single matching record and recall returns only the replacement", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        key: "build_command",
        text: "Run builds with the old command.",
      })

      const corrected = await Memory.correct({
        root: t.root,
        key: "Build Command",
        text: "Run builds with the new command.",
      })
      const shown = await Memory.show({ root: t.root })
      const recall = await Memory.recall({ root: t.root, query: "build_command" })

      expect(corrected.result.added).toBe(1)
      expect(corrected.result.removed).toBe(1)
      expect(shown.sources.environment).not.toContain("build_command")
      expect(shown.sources.corrections).toContain("- build_command :: Run builds with the new command.")
      expect(recall.hits).toHaveLength(1)
      expect(recall.hits[0]?.text).toContain("build_command :: Run builds with the new command.")
    } finally {
      await t.done()
    }
  })

  test("correct preserves the matched key when given a qualified alias", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        key: "build_command",
        text: "Run builds with the old command.",
      })

      await Memory.correct({
        root: t.root,
        key: "environment.md:Commands:build_command",
        text: "Run builds with the corrected command.",
      })
      const shown = await Memory.show({ root: t.root })
      const recall = await Memory.recall({ root: t.root, query: "build_command" })

      expect(shown.sources.environment).not.toContain("Run builds with the old command.")
      expect(shown.sources.corrections).toContain("- build_command :: Run builds with the corrected command.")
      expect(recall.hits).toHaveLength(1)
      expect(recall.hits[0]?.source).toBe("corrections.md")
      expect(recall.hits[0]?.text).toBe("build_command :: Run builds with the corrected command.")
    } finally {
      await t.done()
    }
  })

  test("correct removes only the qualified target when its slug matches another key", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        key: "build_command",
        text: "Run builds with the old command.",
      })
      await Memory.remember({
        root: t.root,
        key: "environment.md_commands_build_command",
        text: "Keep this unrelated project record.",
      })

      await Memory.correct({
        root: t.root,
        key: "environment.md:Commands:build_command",
        text: "Run builds with the corrected command.",
      })
      const shown = await Memory.show({ root: t.root })
      const recall = await Memory.recall({ root: t.root, query: "corrected build command" })

      expect(shown.sources.project).toContain(
        "- environment.md_commands_build_command :: Keep this unrelated project record.",
      )
      expect(shown.sources.environment).not.toContain("Run builds with the old command.")
      expect(shown.sources.corrections).toContain("- build_command :: Run builds with the corrected command.")
      expect(
        recall.hits.some(
          (hit) =>
            hit.source === "corrections.md" && hit.text === "build_command :: Run builds with the corrected command.",
        ),
      ).toBe(true)
    } finally {
      await t.done()
    }
  })

  test("repeating the same correction leaves sources unchanged", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.correct({ root: t.root, key: "stable_command", text: "Run the stable command." })
      const before = await Memory.show({ root: t.root })

      const repeated = await Memory.correct({ root: t.root, key: "stable_command", text: "Run the stable command." })

      expect(repeated.result.added).toBe(0)
      expect(repeated.result.removed).toBe(0)
      expect(repeated.result.operationCount).toBe(0)
      expect((await Memory.show({ root: t.root })).sources).toEqual(before.sources)
    } finally {
      await t.done()
    }
  })

  test("rejects ambiguous corrections without changing any source", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({ root: t.root, key: "shared_key", text: "Project version." })
      await Memory.remember({
        root: t.root,
        file: "environment.md",
        section: "Commands",
        key: "shared_key",
        text: "Environment version.",
      })
      const before = await Memory.show({ root: t.root })

      await expect(Memory.correct({ root: t.root, key: "shared_key", text: "Corrected version." })).rejects.toThrow(
        "project.md:Facts:shared_key, environment.md:Commands:shared_key",
      )

      expect(await Memory.show({ root: t.root })).toEqual(before)
    } finally {
      await t.done()
    }
  })

  test("adds a correction normally when its key is unknown", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })

      const corrected = await Memory.correct({ root: t.root, key: "new_correction", text: "Add this correction." })
      const shown = await Memory.show({ root: t.root })

      expect(corrected.result.added).toBe(1)
      expect(corrected.result.removed).toBe(0)
      expect(shown.sources.corrections).toContain("- new_correction :: Add this correction.")
    } finally {
      await t.done()
    }
  })

  test("keeps the prior record when correction content is rejected", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.remember({ root: t.root, key: "stable_fact", text: "The project has a stable fact." })

      const corrected = await Memory.correct({ root: t.root, key: "stable_fact", text: "I prefer concise answers." })
      const shown = await Memory.show({ root: t.root })

      expect(corrected.result.added).toBe(0)
      expect(corrected.result.removed).toBe(0)
      expect(shown.sources.project).toContain("- stable_fact :: The project has a stable fact.")
      expect(shown.sources.corrections).not.toContain("stable_fact")
    } finally {
      await t.done()
    }
  })

  test("does not expose natural-language recall intent predicates", () => {
    const recall = MemoryRecall as unknown as Record<string, unknown>

    expect("shouldRecall" in recall).toBe(false)
    expect("direct" in recall).toBe(false)
    expect("explicit" in recall).toBe(false)
    expect("continuation" in recall).toBe(false)
  })

  test("rejects current-session digest reads", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await Memory.recordSession({
        root: t.root,
        sessionID: "same-session",
        summary: "Captured deployment checklist for the release.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const current = await MemoryRecall.search({
        root: t.root,
        query: "deployment checklist",
        mode: "digest",
        sessionID: "same-session",
        currentSessionID: "same-session",
      })
      const prior = await MemoryRecall.search({
        root: t.root,
        query: "deployment checklist",
        mode: "digest",
        sessionID: "same-session",
        currentSessionID: "other-session",
      })

      expect(current).toBeUndefined()
      expect(prior?.block).toContain("deployment checklist")
    } finally {
      await t.done()
    }
  })

  test("recovers corrupted state into a safe disabled state", async () => {
    const t = await tmp()
    try {
      await Memory.enable({ root: t.root })
      await writeFile(MemoryPaths.files(t.root).state, "{", "utf8")

      const status = await Memory.status({ root: t.root })
      const files = await readdir(t.root)

      expect(status.state.enabled).toBe(false)
      expect(files.some((file) => file.startsWith("state.json.bad-"))).toBe(true)
    } finally {
      await t.done()
    }
  })

  test("rejects symlinked memory roots", async () => {
    const t = await tmp()
    try {
      const target = path.join(t.dir, "target")
      const link = path.join(t.dir, "link")
      await Memory.enable({ root: target })
      await symlink(target, link)

      await expect(Memory.enable({ root: link })).rejects.toThrow("memory path rejects symlink")
    } finally {
      await t.done()
    }
  })
})
