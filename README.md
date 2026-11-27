# Kilo Code — personal fork

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">The open source coding agent for building with AI in VS Code, JetBrains, or the CLI.</p>

This is a personal fork of [Kilo Code](https://github.com/Kilo-Org/kilocode), with the upstream core plus a set of features built for everyday agent work. It is not an official Kilo release.

Every build is published as its own VS Code extension package (`.vsix`) with its own version (`<upstream version>-fork.<run number>`) and its own GitHub Release, so an installed build can always be matched to its source.

## Fork features

### Secrets are hidden before they reach a model

Keys, tokens, passwords, and URL or Cookie credentials that can be recognized are replaced with `[redacted]` before text is sent to a model. Protection is on by default and covers chat, subagents, prompt enhancement, memory, autocomplete, model checks, and code copies sent for indexing. Your files and saved chat history stay unchanged. The chat marks messages and tool results that contained hidden secrets, and the prompt box warns you before you send one. It is not a guarantee: unlabelled, encoded, and unusual formats can still pass. The protection can be turned off globally in Settings → Experimental or from the CLI.

### Ask a side question with `/btw`

Type `/btw <question>` in VS Code chat or the TUI while the agent keeps working. The answer streams into a card above the prompt in VS Code (a dialog in the TUI) and never enters the session history. The side question replays the session's last model request as a cache-warm prefix, supports follow-ups, history, cancel with Esc, and inserting the Q/A into your next message. Side-question spend is added to the session cost.

### Consult up to three advisors

An on-demand `consult_advisor` tool lets an agent ask another model for a second opinion during planning, when it is stuck, or before finishing a complex task. Up to three named slots can be configured, each with its own model, reasoning variant, short description, and role prompt, with built-in templates for Critic, Security, Devil's advocate, and Plan review. Agents consult the default slot, selected slots, or all of them in parallel, and a role prompt is sent only to its own advisor. Advisors retry transient provider errors twice with short waits instead of hanging the run.

### Clear old context without losing the conversation

A previewed dialog removes heavy old context from the model's view while the chat keeps showing the originals. Choose how many recent turns to keep, review the affected turns, blocks, and estimated tokens, then apply one of three modes: clear old reasoning, clear old tool output, or clear old tool calls and results. The current turn, protected skills, provider-signed reasoning, and unfinished calls stay untouched. Each dialog remembers the number of turns from its last successful clear. The `/shake` command remains the quick one-step action.

### Agent Manager that respects your machine

The Agent Manager orchestrates parallel sessions in isolated git worktrees. In this fork it can put the computer to sleep or into hibernation once the agents finish, with a cancellable one-minute countdown and a separate plain timer. A "Changed files" mode copies the files changed in a worktree into the local branch as-is, even after the base branch was rebased or force-pushed, and asks before overwriting files that also changed locally. Sessions can be tagged, favorited, and color-marked; subagent inspectors show live status, retries, and errors; and opening or creating a local session no longer forces the sidebar open.

### A model selector that follows the project

The chat has a custom model picker with favorites, quick switching, and search across providers. Model choices can be scoped to a workspace: the "Workspace models" switch in Settings → Models copies the current default, small, subagent, advisor, compaction, and mode models into the workspace's `.kilo/kilo.jsonc`, and later edits save there; turning it off returns the workspace to the global models. A subagent model button next to the model selector sets the subagent model for that same scope and saves immediately, without the Settings save bar, while keeping a compatible reasoning effort. Favorite models can be reordered and switched quickly, their ranks stay gap-free, and explicitly selected models and reasoning variants are remembered for each mode when starting new tasks.

### Rules with real controls

Settings → Agent Behaviour → Rules keeps separate Global and Local rule lists instead of one flat list. Rules can be added with a file picker or by typing a path that is validated before saving, switched on and off individually, opened for editing, and removed. The Local list belongs to the workspace, so project rules stay with the repository instead of leaking into every session.

### Provider quotas at a glance

A small quota ring in the chat model selector shows used and remaining limits with reset times for providers that report them, including OpenCode Go 5-hour, weekly, and monthly usage. Reset times use a day-first 24-hour format instead of the locale-dependent 12-hour one.

## Everything else in the fork

- Defer a prompt until the current turn finishes by holding Send until its ring completes; cancel it or return it to the composer with Stop.
- Revert to any answered agent question with "Revert to here"; files go back to a checkpoint taken when the question was asked.
- Fork or copy a session, copy its ID, and convert a read-only subagent session into a regular session.
- On-demand MCP servers that load only when the agent connects them.
- Session tags and favorites, bulk selection and deletion, and grouping of recent sessions by date.
- Attach the staged diff or a git commit from the `@` menu.
- Choose the execution shell used by agent commands and Kilo terminals.
- Groq Whisper voice input, with optional English translation.
- A unified retry and error policy: transient provider errors wait indefinitely with a 60-second cap, while errors only a human or a code change can fix end the run with a clear error.
- No sampling temperature is sent, so models that reject it keep working.
- Telemetry is fully disabled in this fork.
- Snapshot and session-log overhead is reduced: snapshots are captured once per response, streaming tool progress is bounded, oversized diff patches are not stored, and the SQLite WAL is capped.
- Fork VSIX builds get stable `-fork.<run>` versions, and release notes list only the changes since the previous release.

See [CHANGELOG-FORK.md](CHANGELOG-FORK.md) for the complete list of fork changes and [FORK_REBASE.md](FORK_REBASE.md) for how the fork tracks upstream.

## Install

VS Code: download the latest `kilo-vscode-*.vsix` from the [Releases page](../../releases), then run **Extensions: Install from VSIX…** from the command palette. Installing a newer VSIX updates the extension.

From source:

```bash
bun install
bun run extension
```

Run `bun run dev` for the CLI. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks.

## Upstream

This fork tracks [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) `main` and keeps fork changes annotated so upstream updates can be merged regularly. Kilo Code itself is a fork of [OpenCode](https://github.com/anomalyco/opencode). Configuration and behavior that are not listed above follow the [Kilo docs](https://kilo.ai/docs).

Issues and pull requests for this fork belong in this repository, not in the upstream project.

## License

MIT. See [LICENSE](LICENSE).
