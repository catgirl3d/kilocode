---
"@kilocode/cli": minor
"kilo-code": minor
"@kilocode/kilo-indexing": minor
"@kilocode/kilo-memory": patch
---

Hide recognizable access keys and tokens before they are sent to a model. The protection is on by default and covers chat and subagent requests, prompt enhancement, memory, model checks, agent generation, SWE-Pruner, autocomplete, the custom auto router, and new embedding and Qdrant sends; local files, tool arguments, and saved chat history stay unchanged. Card numbers, passwords, images and PDFs, and terminal commands are not covered, and code already stored in the Qdrant index is not cleaned. File tools refuse to write a `[redacted]` marker over an existing key, and a chat blocked by a key shows the reason and how to recover. Turn the protection off globally in Settings → Experimental or in the CLI config.
