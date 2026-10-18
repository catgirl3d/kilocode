// fork_change - new file
/**
 * `git worktree remove --force` follows Windows junctions and empties whatever they point to, so a
 * `.vscode` or `node_modules` junction into the main checkout loses its contents when the worktree
 * is removed. Unlinking the links first leaves git nothing to follow. Node's `fs.rm` does not follow
 * them, so it needs no such help. Shared by the CLI and the VS Code extension.
 */

import fs from "node:fs/promises"
import path from "node:path"

/**
 * Remove every symlink and junction under `dir` without touching what they point to, so a forced
 * `git worktree remove` cannot delete outside the worktree. Resolves once none are left and rejects
 * when a link cannot be removed or a directory cannot be read: callers must then skip git. Real
 * directories are searched too, because package managers put links in `node_modules`. A no-op off
 * Windows, where git deletes a symlink instead of following it.
 */
export async function unlinkLinks(dir: string): Promise<void> {
  if (process.platform !== "win32") return
  const items = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return []
    throw new Error(`refusing a forced git removal, cannot read ${dir}: ${err.message}`)
  })
  for (const item of items) {
    const file = path.join(dir, item.name)
    if (item.isSymbolicLink()) await drop(file)
    if (item.isDirectory()) await unlinkLinks(file)
  }
}

/** A directory link (junction) is removed with `rmdir`; a file symlink needs `unlink`. */
async function drop(file: string): Promise<void> {
  await fs.rmdir(file).catch(() =>
    fs.unlink(file).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`refusing a forced git removal, cannot unlink ${file}: ${err.message}`)
    }),
  )
}
