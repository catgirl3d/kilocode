---
"@kilocode/cli": patch
"kilo-code": patch
---

Keep agents and sub-agents running through provider errors that used to end the turn, including connection resets in the middle of a response. Failed attempts are retried with backoff until you stop the run, and tool calls that already ran are never repeated. Errors that waiting cannot fix, such as a missing API key, a sign-in prompt or an unknown model, still stop the run with a clear error.
