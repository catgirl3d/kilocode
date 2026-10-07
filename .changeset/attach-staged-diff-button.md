---
"kilo-code": minor
---

Add an "Attach staged diff" button to the chat prompt: it writes `git diff --staged` to `staged_diff_output.txt` in the session directory and inserts it as a file mention for the next message, with a notice when there is nothing staged.
