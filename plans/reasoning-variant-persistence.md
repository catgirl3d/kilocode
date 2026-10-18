# Reasoning effort memory fix (A+B)

Spec authority: Alina approved option A+B on 2026-10-16: (A) an opening/recovery path must stop shadowing the remembered reasoning effort with a synthetic Default; (B) a live webview must re-read persisted effort when it opens a session, starts a new chat, or reconnects.

Diagnosis (verified by 5 recon agents, evidence in session ses_eb98f6725ffeBeH1MjJiQ13H1Q):
- Remembered effort lives in extension globalState as `agent/<agent>/<providerID>/<modelID>` and is correct (32 such keys confirmed in the user's live memento).
- `resolveMessagePrefs` maps an absent `variant` to `""` (`session-preferences.ts:28`) and `resolveInfoPrefs` does the same (`:50`). `""` means an EXPLICIT Default in `getVariant` precedence: session key > agent key (`session-variant-store.ts:48-56`).
- Recovery (`session-recovery.ts:23-27`) then writes `session/<id>/<provider>/<model> = ""` before/independently of the remembered value, so the UI shows Default "sometimes" (first-writer-wins between sessionsLoaded and messagesLoaded).
- Backend contract (verified): an explicit Default sent as `variant: ""` is stored as `""` in the user message; an absent variant is omitted from the message. `SessionInfo.model.variant` is `"default"` when no variant was chosen, but the extension hides `undefined`/`""`/`"default"` from SessionInfo (`kilo-provider-utils.ts:205-225`). Message payloads keep `""`/`"default"`/`"max"` as-is.
- Live webview loads persisted variants once per webview lifetime (`session.tsx:784` `onCleanup(variants.load())`); there is no re-read on session open, new draft, or reconnect.

## Global Constraints

- Touch only `packages/kilo-vscode/` (`webview-ui/src/context/...`, `tests/unit/...`, `CHANGELOG-FORK.md`, `.changeset/`). Never touch `packages/opencode/` or other packages.
- Marker rules for this fork: edits in existing files under `packages/kilo-vscode/` mark the added/changed blocks with `// fork_change` (single line: trailing marker; multi-line: `// fork_change start` / `// fork_change end` blocks). New non-exempt source files start with `// fork_change - new file`. `kilocode_change` is forbidden in this package. Test files (`tests/`, `*.test.ts`) are exempt from markers.
- TDD is mandatory: write the failing test first, run it, confirm it fails for the expected reason, then implement. Record the failing output in the report.
- Run tests only as targeted commands from `packages/kilo-vscode`: `bun test tests/unit/<file>.test.ts`. Never run the full suite. Typecheck with `bun run typecheck` from `packages/kilo-vscode`. Format with `bun run format` before committing.
- Commit messages: conventional commits with a scope, e.g. `fix(vscode): keep a remembered reasoning effort on session open`. One commit per task. Work in the current worktree branch `marbled-hub`; never push.
- Minimal diff. No refactors of adjacent code. Do not change the behavior of an explicitly chosen Default.
- Use single-word local names, `const` over `let`, early returns; follow the monorepo style guide.

## Task 1: Recovery must not treat a missing variant as an explicit Default

Problem: recovery converts "no variant data" into the explicit-Default sentinel `""`, which outranks the remembered `agent/...` value and shows Default. Explicit Default (stored as `""` in a message) must keep working.

Files:
- `packages/kilo-vscode/webview-ui/src/context/session-preferences.ts`
- `packages/kilo-vscode/webview-ui/src/context/session-recovery.ts`
- `packages/kilo-vscode/tests/unit/session-preferences.test.ts`
- new `packages/kilo-vscode/tests/unit/session-recovery.test.ts`

Requirements:
1. `resolveMessagePrefs`: carry `msg.model.variant` as-is. An absent variant yields `variant: undefined` (do not fall back to `DEFAULT_VARIANT`). An empty string stays `""` (explicit Default). Make `variant` optional in the `picks`/`unattributed` entries and `MessagePrefs` types. Do not special-case `"default"` beyond keeping it as a value.
2. `resolveInfoPrefs`: return `variant: info.model.variant` when present; omit/undefined when absent. Never synthesize `DEFAULT_VARIANT` here (the extension already hides `undefined`/`""`/`"default"` from SessionInfo, so absence carries no explicit intent).
3. `createSessionRecovery.fill(id, agent, model, variant?)`: accept an optional variant; keep writing the pick/model as before, but write the session variant key only when `variant !== undefined`. An explicit `""` still writes the key.
4. Behavior (regression tests, RED first, then GREEN):
   - a. With `variantSelections["agent/code/<providerID>/<modelID>"] = "max"`, calling `recovery.info({ id, agent: "code", model: { providerID, modelID } })` (no variant) must not create any `session/<id>/...` key, and `getVariant(store, model, variants, "code", id)` (or `variants.current(id)` via `createSessionVariants`) must resolve `"max"`.
   - b. `resolveMessagePrefs` with the newest message lacking a variant yields `picks.code.variant === undefined`; with `variant: ""` yields `""`.
   - c. `recovery.messages(id, [message])` with an explicit `variant: ""` still writes `session/<id>/... = ""` (explicit Default preserved) and `variants.current(id)` shows Default (`undefined`).
   - d. `resolveInfoPrefs` with `variant: "high"` still returns `variant: "high"`.
5. Update the existing tests that pinned the old contract in `tests/unit/session-preferences.test.ts`: the `it.each([undefined, ""])` case at lines 42-52 splits into "missing variant leaves the effort unset" + "explicit empty Default still restores Default"; the expectation at lines 87-97 drops the synthesized `""`; the test at lines 121-127 becomes "a server session without a variant leaves the effort unset". Keep assertions on the real resolver output (no mocks).

Verification commands (from `packages/kilo-vscode`):
- `bun test tests/unit/session-preferences.test.ts tests/unit/session-recovery.test.ts`
- `bun run typecheck`

## Task 2: Re-read persisted effort when a session opens, a new chat starts, or the backend reconnects

Problem: the webview loads persisted `variantSelections` once per lifetime, so effort set in another surface/earlier is invisible until the window reloads.

Files:
- `packages/kilo-vscode/webview-ui/src/context/session-variants.ts`
- `packages/kilo-vscode/webview-ui/src/context/session.tsx`
- `packages/kilo-vscode/tests/unit/session-variants.test.ts`

Requirements:
1. `createSessionVariants`: expose a `reload()` that re-sends `{ type: "requestVariants" }` and applies the answer through the existing listener logic (session-prefixed keys stay ignored, agent keys overwrite). `load()` keeps subscribing exactly once; `reload()` must not add a second listener and must be safe to call before/after `load()`.
2. `session.tsx` wiring: call `reload()` (a) in `selectSession` after switching, (b) when a new chat opens (`clearCurrentSession`, the path every New Task action takes; `mintDraft` runs only at the first send, too late to affect it), and (c) in the reconnect path where the code already reacts to `server.isConnected` becoming true (~lines 2720-2725). Minimal insertions; do not add timers; reuse the existing `variants` object.
3. Keep current behavior: on `variantsLoaded`, `session/`-prefixed keys are skipped (`session-variants.ts:117-121`), agent keys are applied; nothing else changes.
4. Regression tests (RED first) in `tests/unit/session-variants.test.ts`:
   - a. `load()` then `reload()` posts a second `requestVariants` (message log order), and no second `listen` call is made.
   - b. After `reload()` and a fresh `variantsLoaded` dispatch with a new agent key, `selections` reflects the new value; a `session/...` key in the payload is still ignored.
   - c. `reload()` before `load()` does not crash and does not subscribe.
5. Wiring checks: confirm by reading `session.tsx` that the three call sites are reactive (inside the existing handlers), not module top-level; note each file:line in the report.

Verification commands (from `packages/kilo-vscode`):
- `bun test tests/unit/session-variants.test.ts`
- `bun run typecheck`

## Task 3: Fork documentation for the fix

Files:
- `CHANGELOG-FORK.md` (append one bullet under the fork's current section)
- new `.changeset/<slug>.md` with `"kilo-code": patch` and a user-facing imperative description, e.g. "Keep the remembered reasoning effort when reopening a session instead of resetting it to Default".

Requirements:
1. One concise bullet in `CHANGELOG-FORK.md` describing the fix from the user's perspective (remembered reasoning effort survives session open/new chat/reconnect).
2. One changeset file following the repo conventions (`.changeset/README.md`), patch level, imperative mood, no implementation details.
3. No code changes. Commit as `fix(vscode): keep remembered reasoning effort across session open and reconnect` (docs/changeset may share this commit or the Task 2 commit — one commit for Task 3).

Verification: `bun run format` clean for the new files; no tests needed.

## Final Review

After all three tasks: review the whole branch diff (`git merge-base main HEAD` → HEAD) with the final code reviewer, triage deferred minors from the ledger, then run the fork guards that apply to local commits (`bun run script/fork-audit.ts --worktree --select=agent-local` from the repo root is advisory; run it and record the output).
