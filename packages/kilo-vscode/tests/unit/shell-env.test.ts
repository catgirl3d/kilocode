import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { getShellEnvironment, execWithShellEnv, clearShellEnvCache } from "../../src/agent-manager/shell-env"

// On Windows the environment comes from the extension host (Path / USERPROFILE);
// elsewhere it is parsed from a login shell (PATH / HOME).
const pathKey = process.platform === "win32" ? "Path" : "PATH"
const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME"

afterEach(() => {
  clearShellEnvCache()
})

describe("getShellEnvironment", () => {
  it("returns an object with PATH", async () => {
    const env = await getShellEnvironment()
    expect(env).toBeDefined()
    expect(typeof env[pathKey]).toBe("string")
    expect(env[pathKey]!.length).toBeGreaterThan(0)
  })

  it("returns HOME", async () => {
    const env = await getShellEnvironment()
    expect(typeof env[homeKey]).toBe("string")
  })

  it("caches results across calls", async () => {
    const first = await getShellEnvironment()
    const second = await getShellEnvironment()
    expect(first[pathKey]).toBe(second[pathKey])
  })

  it("returns a copy (mutations don't corrupt cache)", async () => {
    const first = await getShellEnvironment()
    first[pathKey] = "/mutated"
    const second = await getShellEnvironment()
    expect(second[pathKey]).not.toBe("/mutated")
  })

  it("handles multiline env values without corrupting PATH", async () => {
    // PATH should never contain newlines — verify it parses correctly
    // even if other env vars have multiline values (e.g. BASH_FUNC_*)
    const env = await getShellEnvironment()
    expect(env[pathKey]).toBeDefined()
    expect(env[pathKey]).not.toContain("\n")
  })
})

describe("execWithShellEnv", () => {
  it("executes a simple command", async () => {
    const { stdout } = await execWithShellEnv("git", ["--version"])
    expect(stdout.trim()).toContain("git version")
  })

  it("passes cwd option through", async () => {
    const cwd = await fs.realpath(os.tmpdir())
    const { stdout } = await execWithShellEnv(process.execPath, ["-p", "process.cwd()"], { cwd })
    expect(path.resolve(stdout.trim())).toBe(path.resolve(cwd))
  })

  it("throws on non-ENOENT errors", async () => {
    await expect(execWithShellEnv("git", ["--definitely-not-a-real-flag"])).rejects.toThrow()
  })

  it("concurrent calls don't reject prematurely", async () => {
    // Both calls should succeed — neither should throw due to a race
    const [a, b] = await Promise.all([
      execWithShellEnv(process.execPath, ["-p", "1 + 1"]),
      execWithShellEnv(process.execPath, ["-p", "2 + 2"]),
    ])
    expect(a.stdout.trim()).toBe("2")
    expect(b.stdout.trim()).toBe("4")
  })
})

describe("clearShellEnvCache", () => {
  it("forces fresh resolution on next call", async () => {
    const first = await getShellEnvironment()
    clearShellEnvCache()
    const second = await getShellEnvironment()
    // Both should succeed and contain PATH
    expect(first[pathKey]).toBeDefined()
    expect(second[pathKey]).toBeDefined()
  })
})
