import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { inside } from "./test-root"

const files = ["kilo.jsonc", "kilo.json", "config.json", "opencode.json", "opencode.jsonc"]

/** Remove global config files written by a test, refusing any path outside the test root. */
export async function clearGlobalConfig() {
  const dir = Global.Path.config
  if (!inside(dir)) throw new Error(`refusing to clear global config outside the test root: "${dir}"`)
  for (const file of files) await fs.rm(path.join(dir, file), { force: true })
}
