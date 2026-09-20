import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { handleEditorAction } from "../../src/kilo-provider/editor-actions"
import { validate } from "../../src/kilo-provider/instruction-path"

describe("instruction path validation", () => {
  let root = ""

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kilo-instruction-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("accepts existing files by relative or absolute path", async () => {
    const file = path.join(root, "rules.md")
    await writeFile(file, "Use small changes.")

    expect(await validate(root, "./rules.md", "project")).toBe(true)
    expect(await validate(root, file, "global")).toBe(true)
  })

  it("rejects missing files and directories", async () => {
    const dir = path.join(root, "rules")
    await mkdir(dir)

    expect(await validate(root, "./missing.md", "project")).toBe(false)
    expect(await validate(root, dir, "project")).toBe(false)
  })

  it("allows remote instructions and glob patterns", async () => {
    expect(await validate(root, "https://example.com/rules.md", "project")).toBe(true)
    expect(await validate(root, "rules/**/*.md", "project")).toBe(true)
  })

  it("allows external global files and rejects external project files", async () => {
    const external = await mkdtemp(path.join(os.tmpdir(), "kilo-global-instruction-"))
    const file = path.join(external, "rules.md")
    await writeFile(file, "Use small changes.")

    expect(await validate(root, file, "global")).toBe(true)
    expect(await validate(root, file, "project")).toBe(false)

    await rm(external, { recursive: true, force: true })
  })

  it("returns the project binding with an asynchronous validation result", async () => {
    await writeFile(path.join(root, "rules.md"), "Use small changes.")

    const message = await new Promise<unknown>((resolve) => {
      const handled = handleEditorAction(
        {
          type: "validateInstructionPath",
          requestId: "request-a",
          path: "./rules.md",
          scope: "project",
          bindingId: "binding-a",
        },
        { dir: () => root, post: resolve },
      )
      expect(handled).toBe(true)
    })

    expect(message).toEqual({
      type: "validateInstructionPathResult",
      requestId: "request-a",
      path: "./rules.md",
      valid: true,
      bindingId: "binding-a",
    })
  })
})
