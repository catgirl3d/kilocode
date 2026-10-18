import { afterEach, describe, expect, it } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { unlinkLinks } from "@opencode-ai/core/kilocode/unlink-links"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kilo-links-")))
  dirs.push(dir)
  return dir
}

/** A directory with a marker at its top and one nested deeper, standing in for a repo `.vscode` or `node_modules`. */
async function target(root: string): Promise<string> {
  const dir = path.join(root, "outside")
  await fs.mkdir(path.join(dir, "deep", "er"), { recursive: true })
  await fs.writeFile(path.join(dir, "MARKER"), "x")
  await fs.writeFile(path.join(dir, "deep", "er", "MARKER"), "x")
  return dir
}

describe("unlinkLinks", () => {
  it.skipIf(process.platform !== "win32")("removes nested junctions and keeps their targets intact", async () => {
    const root = await temp()
    const outside = await target(root)
    const tree = path.join(root, "tree")
    await fs.mkdir(path.join(tree, "client", "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(tree, "client", "keep.txt"), "keep")
    await fs.symlink(outside, path.join(tree, ".vscode"), "junction")
    await fs.symlink(outside, path.join(tree, "client", "node_modules", "pkg", "linked"), "junction")

    await unlinkLinks(tree)

    expect(existsSync(path.join(tree, ".vscode"))).toBe(false)
    expect(existsSync(path.join(tree, "client", "node_modules", "pkg", "linked"))).toBe(false)
    expect(existsSync(path.join(tree, "client", "node_modules", "pkg"))).toBe(true)
    expect(existsSync(path.join(tree, "client", "keep.txt"))).toBe(true)
    expect(existsSync(path.join(outside, "MARKER"))).toBe(true)
    expect(existsSync(path.join(outside, "deep", "er", "MARKER"))).toBe(true)
  })

  it.skipIf(process.platform === "win32")("leaves links alone where git does not follow them", async () => {
    const root = await temp()
    const outside = await target(root)
    const tree = path.join(root, "tree")
    await fs.mkdir(tree)
    await fs.symlink(outside, path.join(tree, "linked"), "dir")

    await unlinkLinks(tree)

    expect(existsSync(path.join(tree, "linked", "MARKER"))).toBe(true)
  })

  it("resolves for a tree without links and for a missing directory", async () => {
    const root = await temp()
    await fs.mkdir(path.join(root, "tree", "sub"), { recursive: true })
    await fs.writeFile(path.join(root, "tree", "sub", "file.txt"), "x")

    await unlinkLinks(path.join(root, "tree"))
    await unlinkLinks(path.join(root, "missing"))

    expect(existsSync(path.join(root, "tree", "sub", "file.txt"))).toBe(true)
  })
})
