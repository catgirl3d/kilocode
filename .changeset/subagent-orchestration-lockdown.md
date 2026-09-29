---
"@kilocode/cli": patch
"kilo-code": patch
---

Keep subagents out of Agent Manager by default: a subagent can no longer create or control Agent Manager sessions unless its own agent configuration explicitly allows the `agent_manager` tool, and broad global permission rules never reopen that boundary.
