// fork_change - new file
import { realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Scope = "global" | "project"

function inside(root: string, file: string) {
  const rel = path.relative(root, file)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function validate(root: string, input: string, scope: Scope): Promise<boolean> {
  if (/^https?:\/\//i.test(input)) return Promise.resolve(true)

  const file = input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(2))
    : path.isAbsolute(input)
      ? input
      : path.resolve(root, input)

  if (/[*?{}[\]]/.test(input)) {
    if (scope === "global") return Promise.resolve(true)
    return Promise.resolve(inside(path.resolve(root), file))
  }

  return Promise.all([realpath(root), realpath(file), stat(file)]).then(
    ([base, target, info]) => info.isFile() && (scope === "global" || inside(base, target)),
    () => false,
  )
}
