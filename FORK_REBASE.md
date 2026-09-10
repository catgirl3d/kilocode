# Fork Rebase Guide

This guide covers regular rebases of this fork's `main` onto `upstream/main`.
It does not describe OpenCode merge automation.

## Responsibilities

- The coordinator is the main agent and is read-only. It owns immutable baseline
  SHAs, fork intent, cross-package decisions, approvals, and review findings.
- Executors are package-scoped subagent sessions, with a root executor for root
  files. Create them lazily and reuse the same session ID throughout the rebase;
  do not start a fresh executor for each conflict.
- Only one executor may mutate the worktree or index at a time. On every activation,
  it re-reads `HEAD`, the replayed fork commit, unmerged paths, and staged paths
  instead of trusting remembered Git state.
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
- Before `git fetch`, record the full SHA values of old `main` and old
  `upstream/main`; use these immutable SHAs in the range-diff.
- Fetch `upstream`, then rebase local `main` onto `upstream/main`.
- Use the repository's `zdiff3` conflict style.
- Do not push without an explicit request.

Keep the commands simple. Do not create backup branches, use stash, or add
platform-specific recipes to this process.

## Conflict Handling

Classify each conflict unit: the conflicted hunk, its entire enclosing function,
declaration, fixture case, or registry entry, and the directly coupled code defined
below. A rebase stop takes the highest route among all its units:
`Mechanical -> Bounded -> Deep`. Record one concise route line per stop; do not
create a separate ledger file or investigation report.

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
   static unique keys and literal values. Removing annotation-only changes leaves
   identical code tokens on all three sides.
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
their units sequentially. After the applicable stop-level audit, the last active
executor confirms no unmerged paths remain and may run `git rebase --continue`
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
unit is staged, the last active executor stops before `git rebase --continue`. Its
compact approval packet contains the original commit, paths, both intents, staged
diff, coupled regions, applicable post-rebase guard, and audit status. The
coordinator verifies that packet and exact staged candidate without repeating the
investigation. Any later index or worktree change invalidates the approval and
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

### Audit Checkpoints

- Before continuing a stop, run one
  `bun run script/fork-audit.ts --worktree <paths...>` for the union of paths where
  the actual diff moves, deletes, or reattaches fork markers or marker-owned code.
  Do not rerun unaffected paths or dispatch a new executor per reported gap.
- If the audit script is not yet present in the replayed tree, record the affected
  paths and run them together as soon as it becomes available. If it is still absent
  at final validation, fail closed and report the missing guard.
- The final full-repository fork audit remains mandatory after all post-rebase fixes.

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

Two mechanical rules prevent audit failures when restoring or adjusting markers:

- Put `// fork_change end` after any fork-added blank lines adjacent to the
  block, and `start` before leading ones. fork-audit treats a block as a run of
  consecutive added lines; a single uncovered blank line marks the whole block
  as missing even though the code itself is wrapped.
- Include every changed marker path in the stop-level audit above and run prettier
  before folding fixes into the annotation commit; the committed audit reads HEAD
  and silently ignores uncommitted edits.

For `bun.lock` conflicts, never resolve manually; use:

```bash
git checkout --theirs bun.lock
bun install
```

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

## Validation

- After every rebase, including a conflict-free rebase, validate the packages and
  contracts containing replayed fork changes, manual resolutions, post-rebase fixes,
  or direct consumers of a changed contract. Do not validate every package touched
  only by the upstream range.
- If dependency inputs changed, synchronize dependencies before any typecheck. Do
  not investigate dependency type errors against stale `node_modules`.
- Run deterministic checks before review agents: structural and annotation guards,
  required generation, fixture and contract typechecks, package typecheck and lint,
  then one aggregate behavior suite per affected package or validation domain. A
  single repository-wide suite may replace them only when it demonstrably covers
  every affected scope; shared or root fixes include all direct consumer packages.
- For VS Code changes with Bounded or Deep resolutions, run sequentially from
  `packages/kilo-vscode/`:

  ```bash
  bun run check-types:fixtures
  bun run check-types
  bun run check-types:webview
  bun run lint
  bun run test:unit
  ```

  Use targeted tests to diagnose a failure or when no aggregate suite exists; do not
  duplicate them routinely before an aggregate suite. Do not run unrelated CLI,
  JetBrains, docs, gateway, or repository-wide suites for a VS Code-only change.
  For conflict-free or Mechanical-only VS Code changes, run the relevant checks from
  `AGENTS.md` without requiring `test:unit` unless executable behavior is affected.
- For CLI, server, or shared changes, use the package-specific checks and affected
  suite policy in `AGENTS.md`; do not run unrelated package suites.
- Run a full-repository gate only when the user explicitly requests it or when the
  resolution changes a cross-package contract, build, or lockfile that cannot be
  validated at package scope.

- Never run root `bun test`; it intentionally fails.
- Keep `AGENTS.md` as the source of truth for additional affected guards.
- Run `bun run check-kilocode-change` from `packages/kilo-vscode/` to ensure no illegal markers were added.
- Run `bun run script/check-opencode-annotations.ts --worktree` from the root when touching shared OpenCode files.
- Run `bun run script/fork-audit.ts` to audit marker coverage and layer compliance across all rebased commits.
- If rebased changes affect server endpoints in `packages/opencode/src/server/`, run `./script/generate.ts` from the repository root and verify the generated SDK changes.
- Check every fork feature affected by the rebase (referenced in `CHANGELOG-FORK.md`).
- For CI, inspect `trigger -> conditions -> needs -> runner -> required status`.

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
passes, the range-diff has been reviewed, and this tracked-file conflict-marker
scan has empty output and exits 1 as expected:

```bash
git grep -nE '^(<{7}|\|{7}|={7}|>{7})( |$)'
```

`zdiff3` helps show the common base in a conflict; it does not validate behavior.
