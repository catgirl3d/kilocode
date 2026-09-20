---
"@kilocode/cli": patch
---

Cap LLM retry waits at 60 seconds. Long provider `retry-after` hints and quota windows no longer cause excessive session stalls.
