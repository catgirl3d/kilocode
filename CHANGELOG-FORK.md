# Kilo Code (Fork Changelog)

## Fork Modifications & Features

### Features & Improvements

- Organize local sessions with reusable colored tags in recent sessions, local history/search, and the active session header; keep session tabs uncluttered.
- Preserve complete typed memory records, deliver them in full during recall when they fit within the response budget, and support exact lookup by `memory_id`.
- Scope fork annotation audits to locally edited or branch-changed files without misclassifying committed fork markers.
- Restore opt-in SWE-Pruner for task-focused `read`, `grep`, and `bash` output pruning, with explicit model selection, bounded no-retry requests, and fail-open safeguards.
- Allow agents to stop background subagent tasks they launched via the task tool.
- Choose the execution shell for agent commands and Kilo terminals from VS Code Settings, with presets and a custom executable path.
- Show a live "Thinking..." row in running sub-agent task lists while the agent reasons, instead of a frozen tool list, with one row per reasoning phase rather than one per step.
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
- Add an on-demand consult_advisor tool with in-progress assistant context and a proposal channel, so agents can request a second opinion from a configured advisor model and reasoning variant during planning, when stuck, or before completing complex tasks.
- Support on-demand MCP servers that load only when the agent connects them, with catalog descriptions, configurable connection permission, and agent-controlled disconnects to release resources when they are no longer needed.
- Show simple live consult_advisor phases in the CLI and VS Code chat: preparation, waiting, reasoning, writing, and completion.
- Improve Agent Manager Markdown document previews with cleaner typography, spacing, and optional comment annotations.
- Group recent sessions by date on the welcome screen and show 7 recent sessions instead of 3.
- Mark sessions with a color from their tab or history context menu in both the sidebar and Agent Manager; the color shows as a tab accent, a thin stripe in local history and recent sessions, and a matching dot in Agent Manager session search, and it persists across VS Code restarts.
- Add an "Attach staged diff" button to the chat prompt: it writes `git diff --staged` to `staged_diff_output.txt` in the session directory and inserts the file as a mention for the next message, with a notice when there is nothing staged.
- Restore the git commits picker in the VS Code chat `@` menu: search repository history, insert a full commit hash, and attach the commit's `git show` details to the next message.

### Fixes & Enhancements

- Mark subagent task cards with an amber dot while the child retries after a provider limit and a red dot when a background child ends in error, instead of showing green running or gray completed.
- Show live activity in the Agent Manager subagent inspector: a busy or retrying child keeps a working row with the retry message and countdown, and its tab marks error or waiting states with a warning icon instead of an unmarked avatar.
- Fix memory corrections so a corrected record replaces the previous version instead of leaving both discoverable.
- Skip pre-commit verification guards while a rebase is in progress, so intermediate rebase commits no longer fail on unfinished trees.
- Remove the dead chat-search auto-expand plumbing (`forceOpen*`) left in the chat message renderer after the upstream search rework; no behavior change.
- Finish that cleanup: drop the disconnected chat-search `forceOpen` adapter from the `kilo-ui` message parts and the task tool card (the generic `BasicTool.forceOpen` API stays); no behavior change.
- Run background processes with the configured execution shell, preserving Bash variable expansion and Auto fallback.
- Keep subagents out of Agent Manager by default: a subagent session no longer receives the `agent_manager` tool unless its own agent config explicitly allows it, and global permission rules or persisted "always allow" approvals cannot reopen that boundary. Nested subagents remain governed by `subagent_depth` as before.
- Keep retryable provider errors (rate limits, usage caps, network failures) waiting indefinitely instead of failing the turn after five attempts; each wait stays capped at 60 seconds.
- Keep ChatGPT Codex sessions alive when the access token is rejected early: an expired-token 401 now waits for token refresh or re-authentication instead of failing the turn, and the session resumes once the token is renewed.
- Make the on-demand `consult_advisor` tool wait through retryable provider errors like the main agent instead of failing the consultation immediately.
- Retry connection resets and other provider errors that arrive after the response started streaming: partial text and reasoning from the failed attempt are discarded and the request repeats, instead of ending the agent or sub-agent with a terminal error.
- When a stream fails after tool calls already ran, keep the finished tool results and continue the turn instead of failing it, so tools are never executed twice.
- Retry provider errors that were previously terminal (bare 400, quota and free-usage limits, unclassified) with the same capped backoff; the operator stops a stuck run. Errors that only the operator or a code change can fix end the run as a red error through the `HOPELESS` table: Kilo sign-in or sign-up, a missing key or sign-in, 401 other than an expired token, 403, 404, requests the provider names invalid or unsupported, and programmer errors (`TypeError`, `ReferenceError`, `RangeError`, `SyntaxError` that are not network failures). Aborts, context overflow, and the internal compaction preflight signal stay terminal.
- Collect the model-error policy in one module, `src/kilocode/session/error-policy.ts`: an ordered rule table (`RULES`) for what retries, resumes, compacts or stops, Kilo's transient-error classification, the retry fallback, and a catalog (`TERMINAL`) of the turn-level failures that still end a run. `session/retry.ts` and `session/processor.ts` only call into it.
- Generate chat titles during the first agent turn, including short prompts, and keep an active title request running if the task is stopped.
- Number favorite models by their visible order in the model picker and quick switcher, so ranks read 1-2-3 without gaps and the reorder arrows skip unavailable favorites instead of stalling on them.
- Store only diff patches that can be displayed: patches above the 256 KB limit are no longer written into the session log, so long sessions stop growing by megabytes per turn. Export, share and remote sync now carry an empty patch for those diffs — the same content every UI already shows.
- Publish streaming tool progress at a bounded rate and size, so a long-running command no longer copies its whole output into the session log on every chunk.
- Cap the SQLite write-ahead log and enable incremental auto-vacuum, so compacting the database no longer leaves a multi-gigabyte `-wal` file behind and freed pages return to the filesystem without rewriting the whole file.
- Reclaim disk space with `kilo session cleanup --vacuum` by truncating the write-ahead log after compaction, and report when another Kilo process keeps the database locked instead of claiming success.
- Exclude the locale key validation suite (`i18n-keys.test.ts`) from VS Code unit test runs, matching the existing `i18n-unused-keys` exclusion.
- Keep snapshots available when slow-repository initialization is left waiting, dismissed, or times out, so a busy machine cannot silently remove rollback support for later turns.
- Make the on-demand `consult_advisor` tool available in plan and ask modes, so second opinions are reachable at planning checkpoints and without leaving a read-only mode.
- Keep the Agent Manager sidebar collapsed when creating a new session or opening an existing session locally.
- Hide the "Move your opencode configuration" notice.
- Hide the "Feedback & Support" button and the "How Agent Manager works" reopen button from the welcome screens in VS Code chat and Agent Manager.
- Remember explicitly selected models and reasoning variants for each mode when starting new tasks.
- Isolate CLI unit tests from the developer's real Kilo setup: test runs no longer read global skills, rules, or VS Code MCP settings from the actual user profile, and docs and VS Code tasks now point at the isolated per-file test runner.
- Cap LLM retry waits at 60 seconds so provider quota windows no longer cause excessive session stalls.
- Speed up Windows voice input by capturing audio natively through WASAPI instead of spawning FFmpeg on each recording.
- Recover snapshots automatically when a stale snapshot index lock is left behind by an interrupted git process, instead of silently disabling snapshots for the project.
- Auto-approve permitted actions before displaying permission prompts and correctly remember exact shell command approvals.
- Recover completed chat responses and clear stale running indicators after reconnecting to the local backend.
- Ignore child status snapshots that arrive after a session is deleted.
- Restore the Memory panel controls and activity indicators, with a separate Compact action.
- Avoid initializing workspace snapshots for reasoning-only and read-only agent steps, and show their status unobtrusively in VS Code chat.
- Prevent nested cards around tool and reasoning output in VS Code chat.
- Preserve earlier conversation history when reverting after message IDs roll over.
- Remove the upstream `PLAN` badge from completed plan messages in VS Code chat.
- Keep title-only reasoning blocks compact in VS Code chat instead of expanding an empty panel while the block is still streaming.
- Stop the background-process runner from spawning a fresh PowerShell per poll, because continuous full WMI enumeration by every running dev server saturated the WMI service and burned CPU: process-tree scans are shared machine-wide through a snapshot cache (about once per 2 seconds in normal operation, faster around exits and stops), probe failures back off instead of killing the process, stop waits for confirmation instead of failing early, and descendants discovered late are still terminated.
- Cut snapshot latency on every mutating agent step by diffing the captured snapshot trees instead of re-staging the worktree, skipping the diff entirely when a step changed nothing, and resolving the repository exclude path once per session instead of on every snapshot.
- Capture snapshots once per root response and when background tasks settle, instead of after every mutating tool or model step.
- Stop the parent agent from idling inside its turn while a background subagent runs: prompts now state that ending the turn does not end the task and that the completion notification resumes the session.
- Fix Windows path normalization in the Promise-facade guard without relaxing its classification checks.
