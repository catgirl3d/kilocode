---
"kilo-code": patch
"@kilocode/cli": patch
---

Stop Windows junctions inside a worktree, such as a `.vscode` or `node_modules` link into the main checkout, from having their targets emptied when the worktree is removed from the Agent Manager, `kilo worktree remove`, or the workspaces dialog.
