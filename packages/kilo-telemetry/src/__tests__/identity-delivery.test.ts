import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kilo-delivery-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function run(env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/identity-process.ts")], {
    env: {
      ...process.env,
      KILO_TELEMETRY_LEVEL: "all",
      KILO_APP_NAME: "kilo-cli",
      KILO_APP_VERSION: "",
      KILO_MACHINE_ID: "test-machine",
      TEST_DATA: dir,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  const result: {
    event: string
    distinct_id: string
    properties: { alias?: string; $set?: Record<string, unknown> }
  }[] = JSON.parse(output)
  return result
}

test("hard-off telemetry sends no events even with KILO_TELEMETRY_LEVEL=all", async () => {
  expect(await run({ TEST_LOGIN: "1" })).toEqual([])
})

test("repeated runs send nothing and collect no identity files", async () => {
  expect(await run({ KILO_MACHINE_ID: "" })).toEqual([])
  expect(await run({ KILO_MACHINE_ID: "" })).toEqual([])
  const files = await readdir(dir)
  expect(files.filter((file) => file.startsWith("telemetry-alias-"))).toEqual([])
  expect(files).not.toContain("telemetry-id")
})

test("a failing transport still produces no events and does not crash", async () => {
  expect(await run({ TEST_FAIL: "1" })).toEqual([])
})

const shell = process.platform === "win32" ? test.skip : test

shell("init and runtime enable do not read the conda token", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "kilo-conda-home-"))
  const marker = path.join(home, "conda-called")
  const conda = path.join(home, "conda")
  const token = "abcdefghijklmnopqrstuv"

  try {
    await mkdir(path.join(home, ".conda"))
    await Bun.write(path.join(home, ".conda", "aau_token"), token)
    await Bun.write(conda, `#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' '{"user_agent":"conda/26.1 c/${token}"}'\n`)
    await chmod(conda, 0o755)

    expect(await run({ TEST_SET_ENABLED: "1", HOME: home, CONDA_EXE: conda })).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
