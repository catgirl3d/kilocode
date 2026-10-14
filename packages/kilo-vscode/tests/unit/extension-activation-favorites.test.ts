import { expect, it } from "bun:test"
import path from "node:path"

it("preserves session favorites through real extension activation", () => {
  const root = path.resolve(import.meta.dir, "../..")
  const fixture = path.join(root, "tests/fixtures/extension-activation-favorites.ts")
  const result = Bun.spawnSync([process.execPath, "test", fixture], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`

  expect(result.exitCode, output).toBe(0)
})
