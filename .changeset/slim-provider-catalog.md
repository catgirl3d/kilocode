---
"kilo-code": patch
---

Load the model catalog faster by sending only the fields the UI uses and reusing the loaded catalog instead of requesting it again on every mount.
