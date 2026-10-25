import os from "os"
import path from "path"

/** Isolated root every test process redirects its XDG paths into. */
export const root = path.join(os.tmpdir(), "opencode-test-data-" + process.pid)

/** True when `target` resolves inside the isolated test root. */
export function inside(target: string): boolean {
  const rel = path.relative(root, path.resolve(target))
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}
