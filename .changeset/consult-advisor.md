---
"@kilocode/cli": minor
"kilo-code": minor
---

Add an optional on-demand `consult_advisor` tool. When `experimental.advisor_model` is configured, agents can request a second opinion from that model at planning checkpoints, when stuck, or before finishing non-trivial work. The configured reasoning variant (`experimental.advisor_variant`) is respected and reported when unavailable.
The model and reasoning variant can also be selected in the extension settings (Models tab).
