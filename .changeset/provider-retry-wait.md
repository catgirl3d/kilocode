---
"@kilocode/cli": patch
"kilo-code": patch
---

Retry provider errors until they recover instead of failing the turn after five attempts. Expired ChatGPT sign-ins stay in retry instead of failing, and advisor consultations wait through rate limits and network errors like the main agent.
