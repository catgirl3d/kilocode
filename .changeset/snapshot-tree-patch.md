---
"@kilocode/cli": patch
---

Reduce snapshot overhead on every mutating agent step by reusing the captured snapshot trees for step diffs, skipping the diff when a step changed nothing, and resolving the repository exclude path once instead of on every snapshot.
