---
"@kilocode/cli": patch
---

Add an opt-out for the durable event journal: set `KILO_EVENT_JOURNAL=off` to stop the local database from keeping a second copy of session history. Chat history, reopening, and continuing sessions read the projected messages and parts and are unchanged. While it is off, journal-backed v2 history/events, replay, and remote workspace sync are unavailable, and turning it back on does not backfill skipped events.
