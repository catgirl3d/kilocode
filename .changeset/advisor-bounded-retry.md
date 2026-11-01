---
"@kilocode/cli": patch
---

Stop consult_advisor from hanging on "Advisor retrying": it now retries a transient provider error twice with short waits, then returns the failure to the agent instead of waiting indefinitely.
