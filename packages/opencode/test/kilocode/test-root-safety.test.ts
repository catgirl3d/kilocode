import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { clearGlobalConfig } from "./global-config"
import { inside, root } from "./test-root"

test("keeps Global paths inside the test root", () => {
  for (const key of ["config", "data", "cache", "state", "home"] as const) expect(inside(Global.Path[key])).toBe(true)
})

test("rejects paths outside the test root", () => {
  expect(inside(root + "0")).toBe(false) // sibling with the same prefix
  expect(inside(path.dirname(root))).toBe(false)
  expect(inside(path.join(root, "..", "x"))).toBe(false)
})

test("refuses to clear global config outside the test root", async () => {
  const previous = Global.Path.config
  ;(Global.Path as { config: string }).config = path.join(os.tmpdir(), "opencode-outside-test-root")
  try {
    await expect(clearGlobalConfig()).rejects.toThrow("outside the test root")
  } finally {
    ;(Global.Path as { config: string }).config = previous
  }
})
