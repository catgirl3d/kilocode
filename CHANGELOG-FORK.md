# Kilo Code (Fork Changelog)

## Fork Modifications & Features

### Features & Improvements

- Restore separate global and local Rules settings with file picking, path validation, and per-entry enable and disable switches.
- Support Groq Whisper voice input with configured Groq API keys and optional English translation.
- Choose a preferred reasoning effort for models without a saved selection.
- Quickly switch to and reorder favorite models from the VS Code chat picker.
- Filter discovered skills by name in Agent Behaviour settings.
- Preserve child session statuses, including retry state, when syncing sessions in the inspector.
- Preview or remove stale child sessions with the `kilo session cleanup` command.
- Allow sending an empty prompt as `continue` when no media or review comments are attached.
- Clear heavy tool outputs from the active session context on demand.
- Add a `Copy session ID` button to sub-agent task cards without cluttering their titles with the full ID.
- Show live sub-agent status dots on task cards: green while running, gray when completed, and red on error.
- Add an optional on-demand consult_advisor tool: agents can request a second opinion from a configured advisor model (experimental.advisor_model, or the Models tab in the extension settings) at planning checkpoints, when stuck, or before finishing non-trivial work.
- Improve Agent Manager Markdown document previews with cleaner typography, spacing, and optional comment annotations.

### Fixes & Enhancements

- Isolate CLI unit tests from the developer's real Kilo setup: test runs no longer read global skills, rules, or VS Code MCP settings from the actual user profile, and docs and VS Code tasks now point at the isolated per-file test runner.
- Cap LLM retry waits at 60 seconds so provider quota windows no longer cause excessive session stalls.
- Speed up Windows voice input by capturing audio natively through WASAPI instead of spawning FFmpeg on each recording.
- Recover snapshots automatically when a stale snapshot index lock is left behind by an interrupted git process, instead of silently disabling snapshots for the project.
- Auto-approve permitted actions before displaying permission prompts and correctly remember exact shell command approvals.
- Recover completed chat responses and clear stale running indicators after reconnecting to the local backend.
- Restore the Memory panel controls and activity indicators, with a separate Compact action.
- Avoid initializing workspace snapshots for reasoning-only and read-only agent steps, and show their status unobtrusively in VS Code chat.
- Prevent nested cards around tool and reasoning output in VS Code chat.
- Preserve earlier conversation history when reverting after message IDs roll over.
- Remove the upstream `PLAN` badge from completed plan messages in VS Code chat.
