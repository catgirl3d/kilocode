---
"@kilocode/sdk": patch
---

Remove 4 remaining duplicated `*1` event schemas (memory status/updated/error, TUI toast) from generated SDK types by sharing one materialized event payload array across the Event unions.
