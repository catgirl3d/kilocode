---
"@kilocode/cli": patch
"kilo-code": patch
---

Stop sending sampling temperature in chat requests, so chat titles, prompt enhancement, commit messages, and branch names keep working when a model rejects it. The agent temperature setting remains accepted for compatibility but has no effect on requests; FIM/autocomplete is unaffected.
