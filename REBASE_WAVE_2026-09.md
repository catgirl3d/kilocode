# Rebase Wave 2026-09 — Report

Rebase of this fork's `main` onto `upstream/main`, performed 2026-09-19/20 per `FORK_REBASE.md`.

## Baselines

| Ref | SHA |
|---|---|
| Old fork main | `9fa653499b` |
| Old upstream/main (pre-fetch) | `a728fbf8f3d209ee8631d9fa8ea6d0afbe6f919d` |
| New upstream/main (rebase base) | `a85ae672a3` |
| Final HEAD | `6167c25e7b` |

- Series: 93 fork commits replayed, 323 new upstream commits absorbed.
- One commit auto-dropped by git: `54da8ea32f` (bun.lock sync — patch contents already upstream).
- One semantic drop-by-design: `04345ef33c` (cherry-pick of upstream `12b44cb7cb` "Pass x-opencode-session…" — now native upstream; replay was empty).
- Force-push NOT performed (requires explicit request).

## Route Ledger (stops)

Stop format: commit, packages, highest route. Routes were classified per
`FORK_REBASE.md` (`Mechanical -> Bounded -> Deep`; tests/config/executable code
never count as Mechanical).

| Stop | Commit | Packages | Route | Notes |
|---|---|---|---|---|
| 1 | `cf01ad9ab4` auto-approve backend shield | opencode, kilo-vscode | Bounded | shell.ts mask+always union; toggle rewritten to backend `allowEverything(runtime)`; marker leak fold-forward; extension.ts 3-arg contract restored |
| 2 | `2537293963` SSE reconnect recovery | kilo-vscode | Bounded | `seedSessionWakeups` + `reconcileSessionStatus` union; KiloProvider reconnect guard composition |
| 3 | `e1912a2586` reasoning effort setting | kilo-vscode | auto | conflict-free |
| 4 | `2191c62c7a` memory panel restore | kilo-vscode, kilo-memory | Bounded | forceOpen machinery vs upstream removal; kilo-ui `Part` `forceOpenFile` prop was removed upstream (`8437096975`) — nested file-open degraded, follow-up |
| 5 | `b0ef5a4760` Groq Whisper | kilo-gateway, kilo-vscode | Deep (coupled cross-package) | exports union `./speech-to-text` + upstream `./tui`/`./claw`; `provider !== "custom"` guard restored |
| 6 | `40da7ea101` translation docs | kilo-vscode | Bounded | `canTranslateSpeechToText` + upstream `capture` param union |
| 7 | `c369155ac7` shake action | kilo-vscode | Bounded | ordering contract `[review, browserText, push, …]` preserved and re-verified |
| 8 | `f15ee12ed6` snapshot deferral | opencode, kilo-vscode | Bounded | shared `session/tools.ts` markers required; `if (builtin)` narrowing restored in `run.ts` |
| 9 | `34a47c0389` sub-agent copy button | kilo-vscode, kilo-ui | Bounded | fork's MessageList hunk superseded by upstream architecture; feature lives in `kilo-ui/message-part.tsx` (`partMetadata?.sessionId` fallback) |
| 10 | `4c6210bac1` skill search filter | kilo-vscode | Bounded | duplicate `.mts` visual-regression spec deleted upstream; skips preserved in `.spec.ts` |
| 11 | `a3e66e6f08` SDK MCP contracts | opencode, sdk, root | Deep | canonical regeneration; 4 MCP required contracts verified; `build.ts` idempotence + retry wrap; upstream switched SDK to `nodenext` → `.js` import extensions in fork test |
| 12 | `d0012c0c92` annotation commit | opencode, kilo-vscode | deferred | annotations are NOT reconciled mid-rebase; conflicted marker hunks dropped to composed content, redone in end pass |
| 13 | `6afc5c9753` advisor tool | sdk | Deep | canonical regen; consult_advisor is internal tool (no REST route); `advisor_model` present |
| 14 | `3c40c29503` finalize integration | kilo-vscode, sdk | Deep | consolidation content already composed; openapi regenerated to HEAD equality |
| 15 | `2ccd880974` empty-prompt continue | kilo-vscode | Bounded | ordering contract regression risk — re-verified; `prompt-send-contract` assertion synced to goal-aware ground truth |
| 16 | `e143ca2ce5` continue guard | kilo-vscode | duplicate | intent already composed |
| 17 | `32e89adf31` advisor phase titles | kilo-vscode | Bounded | contract-test composition + stale assertions updated |
| 18 | `2bfd24db1a` per-mode model/variant store | kilo-vscode | Deep | cross-layer state composition; targeted tests 27/28/20/79 green |
| 19 | `e037ff34de`/`83a51caa82` welcome screen | kilo-vscode | Bounded | hide buttons + date grouping composed over upstream logo/history behavior |
| 20 | `919a2b77f2` consolidate post-rebase | kilo-vscode | Bounded | fold-forwards confirmed; executor staleness incident → rotation |
| 21 | `04345ef33c` x-opencode-session | kilo-memory, opencode | skip | cherry-pick duplicate of upstream `12b44cb7cb` |
| 22 | `50dcf4034b` SWE-Pruner restore | core, kilo-vscode, sdk | Bounded/Deep | config keys union with upstream experimental keys; canonical regen |
| 23 | `afb5e57871` fork-audit rework + reconcile | opencode, kilo-vscode, sdk | deferred | 15 files resolved to composed content; fork-audit rework (+2190 lines) staged intact |
| 24 | `165ab0d1d6` fixture alignment | kilo-vscode | Bounded | fixture restored to ground truth; PromptInput fold-forward |

## Incidents & Problems

1. **Marker leak (stop 1)**: `toggle-auto-approve.ts` was committed with a leftover
   conflict marker when a resolution script failed but `rebase --continue` proceeded.
   Fixed by fold-forward into the next stop's commit; recorded for range-diff review.
2. **Annotation commit attempted a revert (stop 23)**: `afb5e57871` was based on an
   old `shell.ts` and would have reverted the upstream inert-operator masking fix back
   to `source(node)`. Resolving to stage `:2:` protected the fix; both masking
   (`pattern(node, kind, source(node))`) and exact-arity `BashHierarchy.always`
   survive.
3. **Ordering contract (repeated risk)**: `PromptInput.tsx` message ordering
   `[review, browserText, push, contextText, draft]` broke in an earlier round's
   replay; this round it was verified after every relevant stop and at the end.
4. **Executor staleness (2 incidents)**: two executor sessions returned stale packets
   referencing previous stops. Both cases: verify state, rotate executor, hand off
   with concise state. No work was lost.
5. **Cherry-pick duplicates**: `04345ef33c` replayed empty because upstream now owns
   the change; policy recorded: resolve to composed content, expect empty replay, skip.
6. **SDK generator evolution**: upstream rewrote generation in the range
   (`generate.ts` CLI docs step, formatting fix). Fork's Windows-safe write and MCP
   required-params workaround composed onto the current generator; regeneration is
   the canonical resolution for `openapi.json` conflicts.
7. **Upstream `moduleResolution: nodenext`**: broke fork SDK test imports
   (`TS2835`); fixed with explicit `.js` extensions.
8. **Interactive rebase popups**: all rebase commands run with
   `GIT_EDITOR=true` + `core.hooksPath=/dev/null`; hooks intentionally deferred to the
   end (user directive).

## Reviewer-Found Regressions (fixed)

Both issued by the adversarial reviewer after the first freeze; both fixed and
re-reviewed before approval:

1. **Shell always-pattern mismatch** (`d3606b1db3`): masked request patterns vs raw
   text in `BashHierarchy.always` → saved rules never matched masked requests. Fix:
   mask the always-derivation text with the same `pattern(...)` call.
2. **Variant carry losses** (`08787123b8`, `4135350f8b`): explicit effort overridden
   by cached target effort; then explicit default (`""`) lost at the store boundary.
   Final fix: capture raw `variants.choice(id)` (preserves `""`), carry logic
   overrides cache except inherited `undefined`/`max`.

## End Pass (post-rebase)

- Annotation reconciliation: `chore(fork): reconcile annotation coverage after rebase`
  (`950772456b`) — covered 11 FAIL files; committed fork-audit now exits 0 fatal
  (19 inherited upstream warnings remain, intentionally untouched).
- Advisor terminal-title dedupe: `59c722fab0`.
- Test syncs (user-authored): `6167c25e7b` — help snapshot, vcs-watcher, task-model,
  parameters, win32 abort skip; runner per-file timeout 300s→600s (`5397aa9c7e`).
- Reviewers: replay-fidelity PASS, adversarial PASS at `6167c25e7b`.

## Remaining Known Items

- `forceOpenFile` nested file-level open is inactive (kilo-ui `Part` prop removed
  upstream `8437096975`) — small kilo-ui follow-up if wanted.
- Pre-existing: `z-first` vs `unset-effort` contract drift (test encodes
  `50f7d01ad7` contract; implementation matches old main).
- Pre-existing: runtime allow-all can override persisted user-deny rules (unchanged
  from old main; hard rules and `forceAsk` remain protected).
- Windows abort coverage: `tool.shell abort` skipped on win32 (harness limitation,
  `taskkill` path untested); abort/timeout share the kill path.
- Environment-classified suite failures (network 503/429, anaconda not-installed,
  IPv6/serve, background-process identity, EBUSY worktree cleanup, drive-letter
  casing) — verification gaps on this machine, not rebase regressions.

## Lessons

1. Annotations are never touched during the rebase — dedicated end pass only.
2. Inspect every stop's intent (author, message, stat) before dispatching executors.
3. Cherry-picks of upstream commits resolve to composed content and replay empty.
4. Rebase commands always non-interactive (`GIT_EDITOR=true`, hooks disabled).
5. Rotate executors on stale-packet incidents; hand off concise state.
6. Never give agents full-suite instructions without need: VS Code `test:unit` is
   allowed; the opencode package-wide run is hours and only on explicit request.
7. Fold-forward repairs (marker fixes, contract syncs) must be recorded in the
   route ledger for range-diff explanation.
