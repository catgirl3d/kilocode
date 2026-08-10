# Lazy Snapshot Mutation Gate

## Goal

Stop invoking Git snapshots for every agent turn. A reasoning-only or workspace-read-only step must make zero calls to `Snapshot.track`; a snapshot baseline must be created synchronously only before the first tool that can change the current workspace.

## Confirmed Decisions

- Apply the lazy policy to all agent modes, including Code agents, without a feature flag or configuration migration.
- Reuse the shell parser to classify a command as `read` or `unknown`; only `read` bypasses snapshots. Parsing failures and all `unknown` commands fail closed and create a baseline.
- Preserve parent-session diffs for foreground `task` calls by treating them as potentially workspace-mutating. The child session continues to own its own snapshots.
- Treat custom plugin tools and generic MCP tools as potentially workspace-mutating. The three built-in MCP resource tools remain read-only.
- Preserve the existing timeout, progress, `snapshotInitialization: "wait"`, dialog, and `snapshot: false` behavior. The slow-snapshot UI moves from turn start to the first actual mutation boundary.
- Do not create parent snapshots for `background_process` or `task` with `background: true`. Late background changes remain outside the parent diff; lifecycle tracking for their final state is out of scope.
- Keep Kilo-specific policy and state in `src/kilocode/`; shared upstream files receive only narrow hooks marked with `kilocode_change`.

## Design

### Per-step gate

Create a Kilo-owned per-processor gate, for example `packages/opencode/src/kilocode/snapshot/gate.ts`.

- It owns the current step's baseline hash, whether tracking has already been attempted, a single-flight deferred/fiber for concurrent callers, and the persisted `step-start` part when available.
- `ensure()` calls the existing `Snapshot.track` exactly once for the active step and waits for completion before allowing the potentially mutating action to run. A failed, disabled, or timed-out attempt records the attempt and is not retried by parallel tools in that step.
- `startStep()` attaches a previously captured baseline when the AI SDK invokes a tool before emitting `step-start`; when `step-start` was persisted first, a later successful `ensure()` updates that same part with the baseline hash.
- `finishStep()` invokes the existing final `Snapshot.track` only when the step has a baseline. It returns the final hash for the existing patch and session-summary paths, then resets the gate for the next step.
- A step with no baseline persists normal `step-start`/`step-finish` parts without snapshot hashes. `SessionSummary` already returns no diff when either hash is absent, so it must not call snapshot diff functions for those steps.

This preserves the existing `snapshot-tool-race` guarantee: a write tool can execute before an AI SDK `step-start` event, but its baseline still exists before the side effect.

### Workspace mutation classifier

Create a Kilo-owned classifier, for example `packages/opencode/src/kilocode/snapshot/mutation.ts`, that answers whether one tool invocation may mutate the current workspace. It must classify workspace effects only, not writes to Kilo caches, tool-output truncation storage, telemetry, or remote services.

- Always mutable: `edit`, `write`, `apply_patch`, `interactive_terminal`, notebook edit/execute tools, and foreground `task` calls.
- `task` with `background: true` and every `background_process` action: non-snapshotting in the parent session, per the agreed background policy.
- Shell: ask `ShellPermission` for the existing parser-derived access result. `read` is non-mutating; `unknown` is mutating. Invalid arguments, unsupported shells, unparsable commands, redirections, external workdirs, and unrecognized commands remain `unknown`.
- Known read-only built-ins, including file/search/read tools and MCP resource list/template/read tools: non-mutating.
- Generic MCP tools, user-defined local tools, plugin tools, and any unclassified tool: mutating by default.

Do not add a generic side-effect field to shared `Tool.Def` or refactor `ToolRegistry`. The Kilo classifier is the source of truth and defaults to the conservative behavior for future upstream or third-party tools.

## Implementation Steps

1. Add the Kilo-owned gate module under `packages/opencode/src/kilocode/snapshot/`.
   - Accept narrow callbacks/services for `Snapshot.track` and `Session.updatePart` rather than moving processor control flow into a Kilo fork.
   - Implement single-flight `ensure()` so two tool calls in one AI SDK step share one baseline attempt and no tool runs before that attempt settles.
   - Maintain the ordering-safe state required for both event sequences: `tool -> step-start` and `step-start -> tool`.
   - Expose only the operations needed by `SessionProcessor`: begin/attach a step, ensure a baseline, produce a terminal snapshot when a baseline exists, retrieve/reset the baseline.

2. Add the Kilo-owned mutation classifier under `packages/opencode/src/kilocode/snapshot/`.
   - Centralize explicit built-in read/write IDs and argument-sensitive `task` behavior.
   - Default custom, plugin, and MCP calls to potentially mutating.
   - Keep foreground `task` mutable so child edits remain visible in the parent diff; skip only `background: true`.
   - Explicitly skip `background_process` to avoid a misleading parent terminal snapshot before an asynchronous process writes.

3. Extend the existing Kilo section of `packages/opencode/src/tool/shell.ts` with the smallest public helper necessary to reuse its current tree-sitter `collect()` result for snapshot classification.
   - Return only `read` or `unknown`; do not duplicate parser, command allowlist, redirect detection, path detection, or permission logic in the new classifier.
   - Keep the shared-file addition adjacent to existing Kilo shell permission code and mark only the new lines.

4. Replace eager processor tracking in `packages/opencode/src/session/processor.ts` with narrow Kilo gate hooks.
   - Remove the unconditional `snapshot.track()` in `SessionProcessor.create()`.
   - Add a small `Handle` method usable by tool wrappers to call the gate before a mutation.
   - At `step-start`, persist the step part with the gate's current baseline and retain/update its part identity so a baseline captured later can be written back.
   - At `step-finish`, request a final snapshot only when the gate has a baseline; preserve current patch creation and `SessionSummary` behavior only for such steps.
   - Preserve existing `snapshotInitialization` propagation, cancellation, timeout, progress, and `snapshot: false` behavior by routing all real tracking through the existing `Snapshot.track` API.

5. Insert minimal Kilo hooks in `packages/opencode/src/session/tools.ts`.
   - In the registry-backed tool wrapper, run the classifier and `processor.ensureSnapshot()` before `tool.execute.before`, sandbox execution, and the tool itself, because plugin before-hooks can also mutate the workspace.
   - Do the same for generic MCP tool execution, while leaving the explicitly read-only MCP resource wrappers untouched.
   - Extend the local `Pick<SessionProcessor.Handle, ...>` only for the new narrow method; do not restructure upstream tool resolution.

6. Add regression coverage in Kilo-owned tests under `packages/opencode/test/kilocode/`.
   - Unit-test the gate's no-eager behavior, single-flight baseline under parallel mutation attempts, terminal tracking only after a baseline, and no repeated attempt after a failed/disabled baseline in one step.
   - Test both AI SDK orders: a baseline captured before `step-start` is persisted on the later part, and a baseline captured after `step-start` updates that part.
   - Test the classifier with explicit write tools, read-only built-ins, parser-proven `git status`/`git diff`, redirection or unparsable shell commands, unknown plugin/MCP tools, foreground/background `task`, and `background_process`.
   - Add an end-to-end session test where a reasoning/read-only response produces zero `Snapshot.track` calls.
   - Preserve and run `test/session/snapshot-tool-race.test.ts`; add a Kilo integration regression proving an instant write tool still produces a non-empty diff after lazy capture.
   - Add a foreground child-task regression confirming parent diff remains available, and a background-task/process regression confirming no parent baseline is requested.

7. Add a patch changeset describing the user-visible performance improvement without implementation detail.

## Affected Files

- New: `packages/opencode/src/kilocode/snapshot/gate.ts`
- New: `packages/opencode/src/kilocode/snapshot/mutation.ts`
- New: `packages/opencode/test/kilocode/snapshot/lazy-mutation-gate.test.ts`
- New: `.changeset/<generated-name>.md`
- Modified, minimal marked hooks: `packages/opencode/src/session/processor.ts`
- Modified, minimal marked hooks: `packages/opencode/src/session/tools.ts`
- Modified, existing Kilo section only: `packages/opencode/src/tool/shell.ts`
- Potentially modified: `packages/opencode/test/session/snapshot-tool-race.test.ts` only if its assertions need to target the lazy path; otherwise retain it unchanged and cover Kilo behavior in the new test.

## Out of Scope

- Faster implementation of Git snapshot repository initialization itself.
- A config flag or a new metadata contract for plugins/MCP authors.
- Capturing the terminal state of long-running background processes or background subagents after their parent step ends.
- Changing snapshot storage, project/worktree locking, undo/redo APIs, or the existing global `snapshot: false` switch.

## Validation

Run from `packages/opencode/`:

```bash
bun test test/kilocode/snapshot/lazy-mutation-gate.test.ts
bun test test/session/snapshot-tool-race.test.ts
bun run typecheck
```

Run from the repository root:

```bash
bun run script/check-opencode-annotations.ts --worktree
```

Verify manually through tests/logging that a Code agent completing a reasoning-only, `read`/`grep`/`glob`, or parser-proven read-only shell turn performs zero `Snapshot.track` calls; its first foreground mutation performs one baseline and one terminal track per mutating step.
