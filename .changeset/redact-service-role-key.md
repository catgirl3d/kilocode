---
"@kilocode/cli": patch
"kilo-code": patch
"@kilocode/kilo-memory": patch
---

Mask `SERVICE_ROLE_KEY` values like `SUPABASE_SERVICE_ROLE_KEY`, including prefixed spellings, `SUPABASE_SERVICE_KEY`, and key-shaped values under names ending in `SERVICE_KEY`, when recognizable secrets are hidden before sending, and stop refusing edits to files that already contain `[redacted]` markers.
