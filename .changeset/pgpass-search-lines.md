---
"@kilocode/cli": patch
"kilo-code": patch
"@kilocode/kilo-memory": patch
---

Stop hiding search results and code lines that contain `::`, such as GitHub Actions `::error::` commands, and `-u` values of commands other than curl, such as `az rest -u https://…` or `docker run -u 1000:1000`, when recognizable secrets are hidden before sending.
