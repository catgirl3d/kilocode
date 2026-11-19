---
"@kilocode/cli": patch
"kilo-code": patch
---

Keep `kilo.jsonc` valid when removing the last remaining key of an object that ends with a trailing comma, so deleting a provider, agent, or setting no longer fails with `ValueExpected`, and show only the failing line instead of the whole config file when a config cannot be parsed.
