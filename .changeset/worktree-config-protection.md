---
"@kilocode/cli": patch
---

Let auto-approve edit source files inside managed worktrees without asking. Files under `.kilo/worktrees/<name>` are now treated as a separate checkout, so root config files, commands, and skills inside that checkout still require approval while plan files stay exempt.
