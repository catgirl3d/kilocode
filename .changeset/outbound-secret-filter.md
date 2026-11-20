---
"@kilocode/cli": minor
"kilo-code": minor
"@kilocode/kilo-indexing": minor
"@kilocode/kilo-memory": patch
---

Replace recognizable secrets, including access keys, tokens, passwords, and URL or Cookie credentials, in text sent to models. It is not a guarantee that no secret is sent: unlabelled, encoded, and unusual formats can still pass. The protection is on by default and covers chat and subagent requests, prompt enhancement, memory, model checks, agent generation, SWE-Pruner, autocomplete, the custom auto router, and new embedding and Qdrant sends; local files and saved chat history stay unchanged. File tools will not write a `[redacted]` marker over an existing key, and a chat blocked by a key shows the reason and how to recover. Existing records in the Qdrant index are not cleaned. Turn the protection off globally in Settings → Experimental or in the CLI config.
