# Fork Rebase Guide

This guide covers regular rebases of this fork's `main` onto `upstream/main`.
It does not describe OpenCode merge automation.

## Responsibilities

- The coordinator is the main agent and never edits files or resolves conflicts;
  content changes belong to executors. It owns Git orchestration — backup branches,
  `fetch`, starting the rebase, and continuing it except where the Mechanical
  fast-path lets an executor continue autonomously — plus immutable baseline SHAs,
  fork intent, cross-package decisions, approvals, and review findings.
- Executors are package-scoped subagent sessions, with a root executor for root
  files. Create them lazily and reuse the same session ID throughout the rebase;
  do not start a fresh executor for each conflict.
- Only one agent may mutate the worktree or index at a time: coordinator Git
  operations and executor edits are never concurrent. On every activation, the
  executor re-reads `HEAD`, the replayed fork commit, unmerged paths, and staged
  paths instead of trusting remembered Git state.
- An executor may edit only its package. For a stop spanning packages, the relevant
  executors act sequentially; only coupled cross-package behavior or contracts make
  the stop Deep automatically.
- Replace an executor only when its context is demonstrably unreliable, using a
  concise handoff of the current Git state and approved decisions. Rotation is not
  a routine per-conflict step.
- Executors never invent semantic or architectural decisions.
- The user decides only when analysis reveals a genuine architectural, product, or
  contract choice, not for every routine resolution.

## Before Rebasing

Upstream does not receive or contain this fork's changes. The rebase replays local
fork commits over the fetched upstream history. Upstream may independently implement
an overlapping user-facing feature.

- Start with a clean working tree.
- Before any history is rewritten, create a local backup branch pinned to the
  current `main` tip, e.g. `git branch backup/pre-rebase-<short-sha> main`.
  Create it once per rebase, not per stop; keep backup branches local and never
  push them.
- Before `git fetch`, record the full SHA values of old `main` and old
  `upstream/main`; use these immutable SHAs in the range-diff.
- Fetch `upstream`, then rebase local `main` onto `upstream/main`.
- Use the repository's `zdiff3` conflict style.
- All rebase operations and continue steps must be strictly non-interactive: use
  `git -c core.editor=true rebase --continue` (or have `core.editor=true` configured)
  so agent subprocesses never hang waiting for an interactive text editor.
- Do not push without an explicit request.

Keep the commands simple. Do not use stash or add platform-specific recipes to
this process; create backup branches only at the fixed recovery points
(pre-rebase and pre-surgery), never for individual stops, and do not delete them
automatically.

### Rebase Preflight

Start with known risks and available evidence. The check plan is provisional and
changes as the replay reveals actual interactions. Do not delay the first rebase
command for exhaustive recon, a complete contract catalogue, baseline runs, or
timing runs. Keep the plan in the session, not in a repository ledger.

- **Decision batch.** Collect the predictable product and contract choices from the
  recon notes (see below) and
  resolve them with the user before starting. Decisions that only become provable at
  their stop stay with that stop; routine resolutions are not user decisions.
- **Working check plan.** Name checks for the known affected contracts, including
  risks in auto-merged code, and update their scope at actual stops. Record why a
  broader check is needed before expanding. The full CLI suite still requires the
  user's explicit request; planning or measurement cannot authorize it.
- **Baseline when useful.** Reuse existing evidence, or run a specific test on the
  old tree when it helps classify an unexpected failure or an already known risk.
  This is optional, not a prerequisite for starting. Compare old and new trees in
  a comparable environment; running the new tree under the old Bun version is not
  an old-tree baseline. If a failure's origin remains unknown, report that instead
  of declaring it pre-existing. Passing checks do not need a baseline by default.
- **Budgets, not timing runs.** Use existing logs or CI timings when available.
  Without history, the coordinator assigns a finite wall-clock budget based on
  acceptable cost. When a duration is known, set the budget to at least twice it.
  Record duration during the necessary check itself; never launch
  a separate measurement run. Reuse successful results for unchanged inputs in a
  comparable environment, but do not count an old-tree pass as a new-tree pass.
- **History-tool readiness.** Rehearse a representative operation in a scratch
  clone before surgery only when the tool version or relevant Git settings are
  unverified or changed. Reuse a previously verified configuration. This does not
  block starting the rebase or replace the per-operation checks in Fold Verification.
- **Environment stability.** Record the toolchain and relevant environment when
  running checks (`bun --version`, `SHELL`, `COMSPEC`, `KILO_PLATFORM`). Keep it
  comparable when reusing results or checking old versus new behavior.

Recon notes are any pre-rebase notes listing the changed paths on both sides, the
fork features at risk, and known overlap candidates — for example, `git diff
--name-only <merge-base>..<old-main>` for fork paths, the same diff against the
upstream range, and the fork changelog.
They do not need to predict every stop.

### Phase Gates

- Before starting: resolve known decisions and set the initial check scope.
  Unknown interactions and missing baseline or timing data do not block the replay.
- After the last `rebase --continue`: no unapproved scope expansion; the remaining
  work is the closed list of verification findings and owner folds. A skipped commit,
  range-diff anomaly, or reproduced regression is not "new scope" - classify it and
  reopen the gate it belongs to.
- Before freezing the candidate for regression review: final formatting, required
  generation, and the planned final guards have already run explicitly on the
  assembled tree.
- After behavior validation: complete the planned final guards and history
  finalization, not unrelated audits. Reuse check results when only commit SHAs
  changed and the checked inputs and environment remain the same.
- Freeze order: owner folds and history surgery happen before freezing the
  candidate for regression review; any mutation after freeze invalidates reviewer
  approvals.
- Finalization order that avoids rework: required generation -> formatting ->
  structural guards -> package typecheck/lint -> behavior checks -> owner folds ->
  freeze -> committed fork-audit (Marker Discipline step 4). Later steps must not
  change the inputs of already-passed checks.
- After regression review: newly found unrelated defects are follow-ups, not rebase
  work, unless the user explicitly expands scope.

## Conflict Handling

Classify each conflict unit: the conflicted hunk, its entire enclosing function,
declaration, fixture case, or registry entry, and the directly coupled code defined
below. A rebase stop takes the highest route among all its units:
`Mechanical -> Bounded -> Deep`. Record one concise route line per stop; do not
create a separate ledger file or investigation report.

**Stop Checks** are the Git-only checks run at every stop: no unmerged paths
remain, staged paths stay within the assignment scope, `git diff --cached --check`
passes, and the staged files contain no conflict markers. They never include
package typechecks, suites, or audits.

```text
ROUTE stop=<commit> packages=<packages> mechanical=<units> bounded=<units> deep=<units> -> <highest-route>
```

During a rebase, never infer semantic ownership from `ours` or `theirs`. Use the
common base, current upstream-based tree, and replayed fork commit. Never classify
from conflict-marker lines or the final merged diff alone.

### Mechanical Fast-Path

Mechanical is a narrow, fail-closed exact-union path. Before granting it, inspect
the complete index stage `1 -> 2` and `1 -> 3` deltas, or equivalent immutable
snapshots, for every conflicted path in the current stop. Evaluate its conditions in
order and stop at the first failure; a conclusive Scope failure routes the unit to
Bounded or Deep without completing the remaining Mechanical checks.

All four conditions must pass:

1. **Scope**: The conflict and coupled side deltas contain only named `import type`
   specifiers, recognized fork ownership annotations, or additions to a non-exported
   flat module-level object map documented as order-independent and containing only
   static unique keys and literal values. For a pure ownership-annotation conflict,
   removing the annotations must leave identical code tokens on all three sides.
   Type-import and map additions instead satisfy the conditions below.
2. **Additive**: Each non-annotation delta is the base plus additions only. Neither
   side modifies, deletes, renames, moves, or semantically reorders an existing
   element. The result is the exact union, with every element once. Compare syntax
   members rather than whitespace or canonical formatter sorting.
3. **Collision-free**: Added bindings, keys, aliases, and canonical runtime or
   protocol identities are distinct across the sides.
4. **Independent**: The side deltas positively show non-overlapping intent. Commit
   metadata, ownership markers, and `CHANGELOG-FORK.md` may corroborate that result;
   names or missing changelog text never prove it.

Runtime imports, executable code, tests, configuration, schemas, protocol unions,
registries, directives, and generated contracts do not qualify as Mechanical. This
exclusion routes them to Bounded or Deep; it does not make them Deep automatically.
Do not launch research merely to make a Mechanical classification pass.

When every unit in the stop is Mechanical, the relevant package executors resolve
their units sequentially. After Stop Checks, the last active
executor confirms no unmerged paths remain and may run `git -c core.editor=true rebase --continue`
without coordinator approval. Mechanical stops do not trigger conflict-specific
behavioral review later.

### Bounded Resolution

Bounded covers semantic edits whose two intents and exact composition are locally
evident. Executable code, tests, fixtures, and configuration are eligible categories,
not proof that a conflict is Bounded.

Use only this fixed evidence boundary:

- index stages and common base;
- the relevant paths and hunks in the replayed fork commit, plus its message;
- the entire enclosing function, declaration, fixture case, or registry entry;
- imports and local definitions changed by either side and used in that scope;
- one-hop package-local references to changed symbols, without tracing transitive
  consumers;
- the relevant fork annotation or changelog entry when present.

Within that boundary, include auto-merged edits from both side deltas, including code
between conflict hunks. Do not treat unmarked lines as unrelated when they share the
same enclosing declaration or changed symbols. If the evidence boundary cannot prove
one exact result, promote to Deep immediately; do not start research to make Bounded
pass.

Bounded must have no overlapping user-facing feature, state/lifecycle/timing/
concurrency risk, order or precedence ambiguity, persistence or external contract
change, or cross-package dependency. A fixture adapting to a locally obvious API
change can be Bounded; a test changing expected product behavior cannot.

The relevant package executors resolve their Bounded units sequentially. Once every
unit is staged, the last active executor stops before `git -c core.editor=true rebase --continue`. Its
compact approval packet contains the original commit, paths, both intents, staged
diff, coupled regions, local check results, applicable post-rebase guard, and Stop
Checks status. The coordinator verifies that packet and exact staged candidate without
repeating the investigation or successful checks unless their inputs changed or
the evidence is insufficient. Local test permission does not authorize Bounded or
Deep continuation. Any later index or worktree change invalidates the approval and
requires resubmission.

### Deep Resolution

Deep covers overlapping implementations of the same feature, state/lifecycle/timing/
concurrency behavior, ordering or precedence semantics, persistence or external
contracts, ambiguous deletion or replacement, cross-package contracts, and any case
whose intent or result is not proven inside the Bounded evidence boundary.

The executor stops before editing. The coordinator investigates the concrete unknown
and uses a review agent only when a named question requires it and that agent has the
necessary tools. The user decides only genuine product, architecture, or contract
choices. After a decision, the relevant executor implements it and submits the full
staged candidate for coordinator verification before continuing the rebase.

Always preserve or adjust valid fork annotations during conflict resolution and
remove stale annotations as described below.

### Marker Discipline & Audit Checkpoints

- **Do NOT run full fork-audit on intermediate rebase stops**: During stops 1..N of a rebase, focus on code logic and the local checks named in the assignment (see Stop Checks); package typechecks and suites run once on the assembled tree. Do not attempt 100% fork marker coverage or full `fork-audit` runs on intermediate replayed commits — prior fork commits do not yet contain later annotation updates, and running `fork-audit` against `upstream/main` prematurely produces mass false failures.
- **Preserve existing markers during conflict resolution**: When resolving code conflicts, keep existing upstream Kilo markers (`kilocode_change`) and surrounding fork marker wrappers intact. Do not strip markers unless the underlying fork change was completely superseded by upstream.
- **Audit & reconcile annotations strictly at the end**: After all rebase commits are replayed and code builds cleanly, perform the fork annotation audit in one dedicated final pass:
  1. Run `bun run script/fork-audit.ts --worktree` to audit the entire rebased tree against `upstream/main`.
  2. Fix any missing coverage, nested markers, or AST splits across touched files in one batch.
  3. Fold marker fixes into the dedicated annotation commit (e.g. `chore(fork): fix annotation coverage after rebase`) or create a clean follow-up commit.
  4. Finally, run `bun run script/fork-audit.ts` (without `--worktree`) to verify that the committed net fork diff `upstream/main...HEAD` is 100% clean.

### Annotation Commit Conflicts

When a conflict pits an upstream refactor against the fork's annotation commit,
resolve per hunk and never with `git checkout --ours`: taking the whole file
also strips markers around genuine fork changes elsewhere in it.

First determine which annotated regions are still fork-specific. For each
conflicted file, check whether fork commits changed its content before the
annotation commit:

```bash
git diff <merge-base>..<parent-of-the-annotation-commit> -- <file>
```

An empty diff proves every conflicting marker in that file is stale: take the
HEAD side and drop those markers outright. Regions that remain genuinely
fork-specific keep their markers at the original annotation commit's placement.
In shared OpenCode files where both upstream and fork changes use `kilocode_change`,
identify and tag fork-owned blocks with a `[fork]` descriptor (e.g. `// kilocode_change start - [fork] <reason>`).

Two mechanical rules prevent audit failures when restoring or adjusting markers:

- Put `// fork_change end` after any fork-added blank lines adjacent to the
  block, and `start` before leading ones. fork-audit treats a block as a run of
  consecutive added lines; a single uncovered blank line marks the whole block
  as missing even though the code itself is wrapped.
- Include every changed marker path in the final worktree audit (Marker Discipline
  step 1) and run prettier
  before folding fixes into the annotation commit; the committed audit reads HEAD
  and silently ignores uncommitted edits.

For `bun.lock` conflicts, never resolve manually; use:

```bash
git checkout --ours bun.lock
bun install
```

During a rebase, `--ours` is the upstream side and `--theirs` is the fork's old
lockfile; the goal is upstream's dependency set, then `bun install` reconciles it
with the replayed `package.json` changes.

**If upstream independently implements the same or an overlapping feature, stop before
choosing a resolution.** The coordinator must compare the resulting user-facing
contract, behavior, maintenance cost, and relevant tests, then present the fork
implementation, upstream implementation, or a minimal composition to the user. Do
not assume the fork implementation wins; upstream may be the better implementation.

The coordinator may approve a clear non-overlapping Bounded resolution, prioritizing
confirmed fork behavior.
Stop and explain the facts briefly when an architectural, product, or contract
decision is required. Do not expand scope for theoretical edge cases.

If Git itself skips a commit during rebase, inspect its behavior before finalizing the rebase.

Use:

```bash
git range-diff <old-upstream>..<old-main> upstream/main..main
```

Commit retention alone does not prove behavior preservation; review the range-diff
and actual behavior.

### Post-Rebase Fix Ownership

Every fix found during or right after a rebase has exactly one owner commit.
Find it with `git log --oneline -- <file>` or `git log -S <line>` against the
pre-rebase fork history; with a consolidated history this takes a minute.

- **Feature fix folds into its owner.** Commit the fix as a small standalone
  commit at the stop where it was found, finish the rebase, then fold it
  non-interactively with `git-surgeon fold <owner> --from <fix>`. Never use
  `rebase -i --autosquash`. The invariant is one feature per commit; tail
  commits must not grow the stop count of the next rebase.
- **Upstream drift: owner first, one remainder commit per wave.** When upstream
  changed a contract, fixture format, or default that the replayed code must
  adapt to, that is not a feature fix. An adaptation that repairs the code or
  tests of one fork feature folds into that feature's commit with
  `git-surgeon fold <owner> --from <fix>`; the feature must stay
  self-contained. The remainder without a feature owner (generated SDK, docs,
  cross-cutting fixtures, annotations) goes into a single commit named
  `fix(rebase): adapt fork tail to upstream <version> drift`, where
  `<version>` is the upstream release in the rebase base; fold later remainder
  additions into it instead of opening a new commit. Never open a separate
  `adapt <area>` commit per area, and never record drift in `CHANGELOG-FORK.md`
  or changesets: the tail must not grow one stop per adapted area, and the next
  rebase must still see where the adaptation remainder lives.
- **No mega finalize commits.** Commits like `finalize post-rebase
  integration` touching dozens of files across features are forbidden. If a
  fix spans files of several features, split it by hunk to each owner and put
  only the unattributable remainder into the drift or governance commit.
- **Marker and formatting churn accumulates.** Do not commit annotation or
  prettier fixes per stop; fold them once at the end per Marker Discipline
  above.
- **Intermediate commits and final checks.** Commit replay and folding steps
  normally. Do not run final guards on every temporary or incomplete tree. Run
  the planned checks and final fork audit on the assembled result before freezing
  it for review or pushing.


### Fold Verification (history surgery)

Splitting or folding commits (e.g. dissolving a tail extract into its owner
with `git-surgeon split` / `fold` / `amend`) rewrites replayed descendants.
Every such operation ends with three checks before anything is pushed:

- **Tree anchor.** Before the first rewrite, pin the pre-surgery HEAD as a local
  backup branch, e.g. `git branch backup/pre-surgery-<short-sha> HEAD`, and use
  it as `<anchor>`. Afterwards `git diff <anchor> HEAD` must show exactly the
  intended delta (often empty). Any other difference means the machinery dropped
  or duplicated a change.
- **Resurrection scan.** Governance replays can union-merge deleted code back
  to life (observed: extracted advisor memos resurrected by a marker-churn
  replay). After each fold, run per-file logs on the touched files and confirm
  the removed regions stay removed.
- **Rebuild poisoned commits, do not replay them.** If a commit is found to
  contain an accidental deletion or addition, rebuild it with `reset --soft`
  plus selective re-commit rather than replaying it through another rebase.
  Replaying a known-poisoned commit spreads the poison to every descendant.
- **Tool safety (`git-surgeon` 0.1.17).** `split` truncates its target to seven
  characters when editing the rebase todo, and `fold` matches todo entries by
  seven-character prefixes; a longer todo hash makes `split` run past its target.
  Before a surgery run: confirm no rebase is in progress, verify each target prefix
  is unambiguous with `git rev-parse --disambiguate=<short>`, and ensure Git uses
  `core.abbrev=7` for that operation so its todo hashes match. This is per-operation
  Git configuration, not an option passed to `git-surgeon`. The `fold` success
  line prints the target's parent; verify the real target from history, not the
  label.
- **One operation at a time.** After each split or fold, confirm the tree equality
  and the expected history before the next operation; stop on any mismatch instead
  of stacking recovery steps.

## Validation

- **Full CLI suite: user-request only.** Do not run the complete CLI manifest unless
  the user explicitly requests it. This includes unfiltered `bun run test` from
  `packages/opencode/`, invoking the isolated runner for the entire manifest,
  package-wide `bun test`, and equivalent wrappers or batches. A rebase, shared
  runtime change, baseline, timeout, failed targeted test, or broader validation
  gate is not authorization. No coordinator or subagent may grant the exception.
  Use targeted checks of affected CLI contracts and direct consumers instead.
  Authorization applies to the requested run, not automatic full-suite reruns.
- **JetBrains validation is disabled.** Exclude `@kilocode/kilo-jetbrains` from
  automatic checks; the root `bun run typecheck` already applies this exclusion.
  Do not run Gradle/Java typechecks or tests, invoke wrappers or CI scripts as a
  workaround, or install/probe Java for validation. This restriction also applies
  to direct-consumer and full-repository gates. If this package changes, record
  its verification gap rather than claiming it was checked.
- After every rebase, including a conflict-free rebase, validate the packages and
  contracts containing replayed fork changes, manual resolutions, post-rebase fixes,
  or direct consumers of a changed contract. Do not validate every package touched
  only by the upstream range.
- If dependency inputs changed, synchronize dependencies before any typecheck. Do
  not investigate dependency type errors against stale `node_modules`.
- Run the deterministic checks in the Phase Gates finalize order (finalization ->
  formatting -> guards -> typecheck/lint -> behavior checks -> folds -> freeze),
  which already places required generation and formatting before the guards. Add
  the committed fork-audit run as the last step after owner folds (Marker
  Discipline step 4). These must cover affected
  contracts and their direct consumers, not just files with textual conflicts.
  A broader aggregate requires the plan's recorded escalation condition; shared or
  root fixes include all direct consumer packages.
- For VS Code changes with Bounded or Deep resolutions, run sequentially from
  `packages/kilo-vscode/`:

  ```bash
  bun run check-types:fixtures
  bun run check-types
  bun run check-types:webview
  bun run lint
  bun run test:unit
  ```

  Executors may use targeted tests at a stop to verify the resolved contract, as
  specified in their assignment. They need not wait for a final aggregate failure
  to obtain local feedback. Do not run every nearby test routinely or duplicate
  successful checks without a changed candidate or a concrete coverage gap. Do not
  run unrelated CLI, JetBrains, docs, gateway, or repository-wide suites for a
  VS Code-only change.
  For conflict-free or Mechanical-only VS Code changes, run the relevant checks from
  `AGENTS.md` without requiring `test:unit` unless executable behavior is affected.
- For CLI, server, or shared changes, use the package-specific checks and affected
  suite policy in `AGENTS.md`; do not run unrelated package suites. The full CLI
  restriction above still applies, even when the coordinator expands the check plan.
- Run a full-repository gate only when the user explicitly requests it or when the
  resolution changes a cross-package contract, build, or lockfile that cannot be
  validated at package scope. The gate is the root `bun run typecheck` and
  `bun run lint`; it does not include the full CLI suite (still user-request only)
  or any JetBrains check (disabled).

- Never run root `bun test`; it intentionally fails.
- Keep `AGENTS.md` as the source of truth for additional affected guards.
- Run `bun run check-kilocode-change` from `packages/kilo-vscode/` to ensure no illegal markers were added.
- Upstream CI does not run fork-owned guards. After every rebase, run
  `bun run check-types:fixtures` from `packages/kilo-vscode/` even when the
  package's only new content is upstream: upstream files can pass upstream CI
  and still fail the fork's fixture tsconfig.
- Run `bun run script/check-opencode-annotations.ts --worktree` from the root when touching shared OpenCode files.
- If rebased changes affect server endpoints in `packages/opencode/src/server/`, run `./script/generate.ts` from the repository root and verify the generated SDK changes.
- Check every fork feature affected by the rebase (referenced in `CHANGELOG-FORK.md`).
- For CI, inspect `trigger -> conditions -> needs -> runner -> required status`.

### Check Execution Rules

- Run at most one heavy process at a time across all agents. Aggregate test suites,
  package or repository-wide typechecks, builds, and generation use that slot.
  Parallel heavy processes on one workstation skew timings and obscure results.
- **Concrete local assignments.** Each executor assignment names a command or
  unambiguous test/file scope, working directory, and finite wall-clock budget.
  The coordinator supplies these; do not ask the executor to research a check's
  cost before running it. If they are missing, correct the assignment once rather
  than requesting approval for every invocation.
- **Local feedback is allowed.** Executors may run assigned isolated test files
  or selected cases, lint on changed files, and genuinely file-scoped type
  diagnostics when supported. Assigned checks are authorized within their scope
  and budget, without a separate permission or performance probe. For example,
  `bun test ./test/tool/tool-define.test.ts` runs from `packages/opencode/`, never
  the repository root. Include the commands, exit codes, results, and any gaps in
  the approval packet alongside Stop Checks.
- **Heavy checks stay centralized.** Executors must not independently launch
  package or repository suites, full typechecks, builds, or broad guard scans.
  The coordinator or one designated validator runs those checks sequentially and
  owns their logs. The coordinator owns the check plan and verifies executor
  results; it need not rerun every successful local check without new evidence.
- **Stay within the assigned budget.** An isolated integration test is not
  forbidden merely because its fixture starts a server. If the check launches
  unplanned heavy work or exceeds its budget, stop it, report the evidence, and
  hand it to the coordinator. Do not silently expand to a suite or raise the
  timeout. Never leave a timed-out process running before starting another check.
- A required generation step (for example SDK regeneration) is an explicitly
  assigned mutation by one executor and occupies the same heavy slot. Its normal
  pipeline may include a build or typecheck; that is not permission to launch
  additional verification suites. The coordinator verifies the generated delta.
- Every heavy run records its command, working directory, candidate SHA and tree, environment
  (`bun --version`, `SHELL`, `COMSPEC`, `KILO_PLATFORM`), full stdout and stderr log,
  numeric exit code, duration, and an explicit PASS / FAIL / TIMEOUT / INCOMPLETE
  status.
- Decide from the process outcome, not from red lines inside the log: a handled
  formatter or retry error is not a failure. Individual assertion failures in a
  partial log are evidence, but a killed run has no final aggregate verdict or
  complete failure list. Treat its timeout as INCONCLUSIVE. Diagnose before a
  targeted retry, confirm the old process tree has exited, and stay within the
  assignment's budget; only the coordinator may approve a larger budget. An
  aggregate suite is not retried automatically. Diagnose the failed case or timeout
  and reassess scope and budget before another run.

### Regression Review

Structural gates (range-diff, fork-audit, typecheck, lint) do not prove behavior
preservation. Review the range-diff against both the pre-rebase fork HEAD and the new
`upstream/main`, then use this fixed reviewer policy:

- Do not launch review agents for a conflict-free or Mechanical-only rebase. Use the
  coordinator's range-diff review and affected deterministic checks.
- Classify manual post-rebase repairs with the same three routes. Any Bounded or Deep
  repair triggers this reviewer policy even when the rebase itself was conflict-free
  or Mechanical-only.
- If any Bounded or Deep resolution occurred, first make deterministic checks green
  or classify failures against a verified baseline. Freeze the resulting candidate
  by recording `HEAD` with a clean worktree, then launch exactly two concurrent
  read-only reviewer sessions.
- The replay-fidelity reviewer compares only verified original/replayed commit pairs
  containing Bounded or Deep resolutions.
- The adversarial reviewer inspects only resolved units, their minimum coupled
  regions, and direct dependencies needed to validate those regions. Findings stay
  limited to consequences of the resolutions.
- Any mutation after freezing the candidate invalidates both reviewer approvals.
  Rerun affected deterministic checks, record a new clean `HEAD`, and resume both
  existing reviewer session IDs against that SHA until both approve. Do not create a
  third reviewer.
- Reviewer and research prompts must require the concrete capabilities needed by the
  question. An agent without Git access cannot answer a Git-history question.
- Classify every finding as exactly one of:
  - **rebase regression** — caused by the resolution; fix before finishing, then
    re-run validation;
  - **upstream behavior change** — verify the fork feature still composes with
    the new upstream semantics;
  - **pre-existing** — inherited from earlier fork history; record as follow-up,
    do not silently absorb it into the rebase.
- Do not include translation/i18n searches in the default regression review. Audit
  localization only when the rebase changes locale files or translation keys, or
  when the user explicitly requests it.
- A relevant test that hangs, times out, or cannot execute in the local
  environment is an explicit verification gap. Name it in the final report;
  do not treat the remaining green checks as full coverage.

Finish only when the working tree is clean, `git diff --check upstream/main..main`
passes, the range-diff has been reviewed, the planned behavior checks pass or their
failures have been classified as above or reported to the user as origin unknown, and this tracked-file conflict-marker scan
has empty output and exits 1 as expected:

```bash
git grep -nE '^(<{7}|\|{7}|={7}|>{7})( |$)'
```

### Post-Rebase Merge Artifact Gate

Before finalizing or pushing, audit for subtle merge artifacts that bypass TypeScript compilation:

1. **Behavior checks from the preflight plan**:
   Run the named tests covering replayed or resolved contracts and their direct
   consumers. Use a full package suite only when the plan requires it, including
   the VS Code requirement above. The complete CLI suite still requires the user's
   explicit request; a plan, broader gate, or change in `packages/opencode/` does
   not authorize it. Typechecks do not prove runtime ordering or behavior.
2. **Dual-inclusion & duplicate assertion audit**:
   Inspect the fork diff against merge-base (`git diff $(git merge-base HEAD upstream/main)..HEAD`) for conflicting or duplicate assertions in tests where both the pre-migration and post-migration expectations were inadvertently retained (such as conflicting `expect()` calls).
3. **Semantic reordering & contract drift**:
   Verify that string concatenation orders, message pipelines, or array compositions (such as prompt assembly in `PromptInput.tsx`) preserve contract ordering required by downstream parsers (tested by `prompt-send-contract.test.ts`, `code-context.test.ts`).
4. **Retired config key cleanup**:
   When upstream moves or deprecates config keys (e.g. from `experimental.*` to top-level), search for lingering old references across tests and fork additions:

   ```bash
   git grep "<old_config_key>"
   ```

`zdiff3` helps show the common base in a conflict; it does not validate behavior.
