// kilocode_change - new file
import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { ConfigProtection } from "../../../src/kilocode/permission/config-paths"
import { Global } from "@opencode-ai/core/global"
import { KilocodePaths } from "../../../src/kilocode/paths"
import { tmpdir } from "../../fixture/fixture"

describe("ConfigProtection.isRequest", () => {
  const config = path.resolve(Global.Path.config)
  const legacy = KilocodePaths.globalDirs().map((d) => path.resolve(d))

  // --- external_directory: bash-originated (empty metadata) ---

  test("returns true for bash external_directory targeting global config", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [config + "/*"],
      metadata: {},
    })
    expect(result).toBe(true)
  })

  test("returns true for bash external_directory targeting skill dir", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [path.join(config, "skills", "my-skill") + "/*"],
      metadata: {},
    })
    expect(result).toBe(true)
  })

  test("returns true for bash external_directory targeting legacy global dir", () => {
    for (const dir of legacy) {
      const result = ConfigProtection.isRequest({
        permission: "external_directory",
        patterns: [dir + "/*"],
        metadata: {},
      })
      expect(result).toBe(true)
    }
  })

  // --- external_directory: file-tool-originated (has metadata.filepath) ---

  test("returns false for file-tool external_directory targeting global config", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [config + "/*"],
      metadata: { filepath: path.join(config, "kilo.json"), parentDir: config },
    })
    expect(result).toBe(false)
  })

  test("returns false for file-tool external_directory targeting global config root dir", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [config + "/*"],
      metadata: { filepath: config, parentDir: config },
    })
    expect(result).toBe(false)
  })

  test("returns false for file-tool external_directory targeting readable global command dir", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [path.join(config, "command") + "/*"],
      metadata: { filepath: path.join(config, "command", "foo.md"), parentDir: path.join(config, "command") },
    })
    expect(result).toBe(false)
  })

  test("returns false for file-tool external_directory targeting readable global skill dir", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: [path.join(config, "skills") + "/*"],
      metadata: {
        filepath: path.join(config, "skills", "my-skill", "SKILL.md"),
        parentDir: path.join(config, "skills"),
      },
    })
    expect(result).toBe(false)
  })

  // --- external_directory: non-config dirs ---

  test("returns false for bash external_directory targeting non-config dir", () => {
    const result = ConfigProtection.isRequest({
      permission: "external_directory",
      patterns: ["/tmp/some-project/*"],
      metadata: {},
    })
    expect(result).toBe(false)
  })

  // --- edit permission ---

  test("returns true for edit targeting global config file via metadata.filepath", () => {
    const result = ConfigProtection.isRequest({
      permission: "edit",
      patterns: [],
      metadata: { filepath: path.join(config, "config.json") },
    })
    expect(result).toBe(true)
  })

  test("returns true for edit targeting skill file via metadata.filepath", () => {
    const result = ConfigProtection.isRequest({
      permission: "edit",
      patterns: [],
      metadata: { filepath: path.join(config, "skills", "my-skill", "SKILL.md") },
    })
    expect(result).toBe(true)
  })

  test("returns true for edit targeting legacy global dir via metadata.filepath", () => {
    for (const dir of legacy) {
      const result = ConfigProtection.isRequest({
        permission: "edit",
        patterns: [],
        metadata: { filepath: path.join(dir, "config.json") },
      })
      expect(result).toBe(true)
    }
  })

  test("returns true for edit targeting relative config path via patterns", () => {
    const result = ConfigProtection.isRequest({
      permission: "edit",
      patterns: [".kilo/command/foo.md"],
    })
    expect(result).toBe(true)
  })

  test("returns false for edit targeting excluded subdir (plans)", () => {
    const result = ConfigProtection.isRequest({
      permission: "edit",
      patterns: [".kilo/plans/plan.md"],
    })
    expect(result).toBe(false)
  })

  test("returns false for read permission", () => {
    const result = ConfigProtection.isRequest({
      permission: "read",
      patterns: [".kilo/config.json"],
    })
    expect(result).toBe(false)
  })

  test("returns false for bash permission", () => {
    const result = ConfigProtection.isRequest({
      permission: "bash",
      patterns: ["cat " + path.join(config, "config.json")],
    })
    expect(result).toBe(false)
  })

  test("returns true for edit targeting root config files", () => {
    for (const file of ["kilo.json", "kilo.jsonc", "AGENTS.md"]) {
      const result = ConfigProtection.isRequest({
        permission: "edit",
        patterns: [file],
      })
      expect(result).toBe(true)
    }
  })

  test("returns false for edit targeting non-config files", () => {
    const result = ConfigProtection.isRequest({
      permission: "edit",
      patterns: ["src/index.ts"],
    })
    expect(result).toBe(false)
  })

  test("protects package lock files in project config directories", () => {
    for (const file of [".kilo/package-lock.json", ".kilocode/package-lock.json"]) {
      expect(ConfigProtection.isRequest({ permission: "edit", patterns: [file] })).toBe(true)
    }
  })

  test("protects a combined source and config lockfile edit", () => {
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: ["src/app/layout.tsx", ".kilo/package-lock.json", ".kilocode/package-lock.json"],
        metadata: {
          filepath: "src/app/layout.tsx, .kilo/package-lock.json, .kilocode/package-lock.json",
        },
      }),
    ).toBe(true)
  })
})

describe("ConfigProtection.isRequest managed worktrees", () => {
  const dirs = [".kilo", ".kilocode"] as const
  const roots = ["kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc", "AGENTS.md"]
  const protectedFiles = [
    ".kilo/command/foo.md",
    ".kilocode/command/foo.md",
    ".kilo/skills/my-skill/SKILL.md",
    ".kilo/package-lock.json",
  ]
  const isProtected = (pattern: string) => ConfigProtection.isRequest({ permission: "edit", patterns: [pattern] })

  for (const dir of dirs) {
    test(`${dir}: source files inside a managed worktree are not configuration`, () => {
      for (const pattern of [
        `${dir}/worktrees/remove-default-server/client/src/stores/modeStatus.ts`,
        `${dir}\\worktrees\\remove-default-server\\client\\src\\stores\\modeStatus.ts`,
      ])
        expect(isProtected(pattern)).toBe(false)
    })

    test(`${dir}: root config files inside a managed worktree stay protected`, () => {
      for (const file of roots) expect(isProtected(`${dir}/worktrees/feature/${file}`)).toBe(true)
    })

    test(`${dir}: config paths inside a managed worktree stay protected`, () => {
      for (const file of protectedFiles) expect(isProtected(`${dir}/worktrees/feature/${file}`)).toBe(true)
    })

    test(`${dir}: plan files stay exempt inside a managed worktree`, () => {
      expect(isProtected(`${dir}/worktrees/feature/.kilo/plans/plan.md`)).toBe(false)
    })

    test(`${dir}: worktree container paths stay protected`, () => {
      for (const pattern of [
        `${dir}/worktrees`,
        `${dir}/worktrees/`,
        `${dir}/worktrees/feature`,
        `${dir}/worktrees/feature/`,
      ])
        expect(isProtected(pattern)).toBe(true)
    })

    test(`${dir}: lookalike containers stay protected`, () => {
      expect(isProtected(`${dir}/worktrees-old/feature/src/index.ts`)).toBe(true)
    })

    test(`${dir}: parent traversal cannot escape worktree protection`, () => {
      expect(isProtected(`${dir}/worktrees/feature/../../command/foo.md`)).toBe(true)
    })

    test(`${dir}: nested worktree containers classify the innermost checkout`, () => {
      expect(isProtected(`${dir}/worktrees/outer/.kilo/worktrees/inner/src/index.ts`)).toBe(false)
      expect(isProtected(`${dir}/worktrees/outer/.kilo/worktrees/inner/kilo.json`)).toBe(true)
    })

    test(`${dir}: nested worktree containers inside config directories stay protected`, () => {
      expect(isProtected(`${dir}/command/.kilo/worktrees/feature/src/index.ts`)).toBe(true)
    })

    test(`${dir}: worktree containers below a package keep the nested config rule`, () => {
      expect(isProtected(`packages/app/${dir}/worktrees/feature/src/index.ts`)).toBe(true)
    })
  }

  test("edit requests combine relative patterns with absolute metadata paths", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const source = path.join(root, ".kilo", "worktrees", "feature", "client", "src", "index.ts")
    const config = path.join(root, ".kilo", "worktrees", "feature", "kilo.json")
    const request = (file: string) =>
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: [path.relative(root, file).replaceAll("\\", "/")],
        metadata: { filepath: file, files: [{ filePath: file }] },
      })
    expect(request(source)).toBe(false)
    expect(request(config)).toBe(true)
  })

  test("mixed source and config patterns stay protected", () => {
    expect(
      ConfigProtection.isRequest({
        permission: "edit",
        patterns: ["client/src/index.ts", ".kilo/worktrees/feature/kilo.json"],
      }),
    ).toBe(true)
  })
})

describe("ConfigProtection.isGlobalSkillRequest", () => {
  const roots = [Global.Path.config, ...KilocodePaths.globalDirs()]

  test("allows one exact global skill subtree", () => {
    for (const root of roots) {
      const pattern = path.join(root, "skills", "axiom-sre", "*")
      expect({
        root,
        result: ConfigProtection.isGlobalSkillRequest({
          permission: "external_directory",
          patterns: [pattern],
        }),
      }).toEqual({ root, result: true })
    }
  })

  test("allows multiple paths within the same global skill", () => {
    const root = path.join(roots[1], "skills", "axiom-sre")
    const patterns = [path.join(root, "*"), path.join(root, "scripts", "*")]
    expect(ConfigProtection.isGlobalSkillRequest({ permission: "external_directory", patterns })).toBe(true)
    expect(ConfigProtection.globalSkillPattern({ permission: "external_directory", patterns })).toMatch(
      /\/skills\/axiom-sre\/\*$/,
    )
  })

  test("rejects broad, mixed, edit, and mismatched requests", () => {
    const root = path.join(roots[1], "skills")
    const first = path.join(root, "axiom-sre", "*")
    const second = path.join(root, "other", "*")
    expect(
      ConfigProtection.isGlobalSkillRequest({
        permission: "external_directory",
        patterns: [path.join(root, "*")],
      }),
    ).toBe(false)
    expect(ConfigProtection.isGlobalSkillRequest({ permission: "external_directory", patterns: [first, second] })).toBe(
      false,
    )
    expect(ConfigProtection.isGlobalSkillRequest({ permission: "edit", patterns: [first] })).toBe(false)
    expect(ConfigProtection.globalSkillPattern({ permission: "external_directory", patterns: [first] })).toBe(
      first.replaceAll("\\", "/"),
    )
  })

  test("rejects symlink escapes from a global skill", async () => {
    const skills = path.join(Global.Path.config, "skills")
    const outside = path.join(Global.Path.config, "outside")
    const root = path.join(skills, "linked-skill")
    const nested = path.join(skills, "nested-skill")
    await fs.mkdir(outside, { recursive: true })
    await fs.mkdir(nested, { recursive: true })
    const type = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(outside, root, type)
    await fs.symlink(outside, path.join(nested, "link"), type)

    try {
      expect(
        ConfigProtection.globalSkillPattern({
          permission: "external_directory",
          patterns: [path.join(root, "*")],
        }),
      ).toBeUndefined()
      expect(
        ConfigProtection.globalSkillPattern({
          permission: "external_directory",
          patterns: [path.join(nested, "link", "*")],
        }),
      ).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(nested, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("canonicalizes aliases to the physical global skill root", async () => {
    await using globalTmp = await tmpdir()
    await using aliasTmp = await tmpdir()
    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path
    const skill = path.join(globalTmp.path, "skills", "canonical-skill")
    const alias = path.join(aliasTmp.path, "alias")
    await fs.mkdir(skill, { recursive: true })
    await fs.symlink(skill, alias, process.platform === "win32" ? "junction" : "dir")

    try {
      const request = { permission: "external_directory", patterns: [path.join(alias, "*")] }
      const pattern = ConfigProtection.globalSkillPattern(request)
      expect(pattern).toMatch(/\/skills\/canonical-skill\/\*$/)
      expect(pattern).not.toContain(aliasTmp.path.replaceAll("\\", "/"))
      expect(ConfigProtection.isRequest(request)).toBe(true)
    } finally {
      ;(Global.Path as { config: string }).config = prev
      await fs.rm(alias, { recursive: true, force: true })
    }
  })

  test("rejects glob characters in the canonical rule", async () => {
    await using tmp = await tmpdir()
    const prev = process.env.XDG_CONFIG_HOME
    const root = path.join(tmp.path, "profile[")
    const skill = path.join(root, "kilo", "skills", "unsafe-root")
    process.env.XDG_CONFIG_HOME = root
    await fs.mkdir(skill, { recursive: true })

    try {
      expect(
        ConfigProtection.globalSkillPattern({
          permission: "external_directory",
          patterns: [path.join(skill, "*")],
        }),
      ).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })
})
