# Fork Rebase Guide

This guide covers regular rebases of this fork's `main` onto `upstream/main`.
It does not describe OpenCode merge automation.

## Responsibilities

- The coordinator is the main agent and is read-only.
- The coordinator researches conflicts, intent, call chains, state, and contracts,
  coordinates review, and may choose a clear resolution that prioritizes confirmed
  fork features.
- The executor is a subagent. It performs write operations such as fetch, rebase,
  and an approved conflict resolution.
- The executor must stop before `git rebase --continue` for any substantive
  conflict and report the relevant facts to the coordinator.
- The executor never invents semantic or architectural decisions.
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

A substantive conflict touches executable code, configuration, tests, workflows, or a user-facing contract unless the coordinator demonstrates it is formatting-only.

Do not mechanically combine substantive conflicts. Compare the common base,
upstream intent, and fork intent (identified by `// fork_change` and `// kilocode_change`
markers, or `CHANGELOG-FORK.md`). Determine whether the changes implement one
contract or independent changes, then trace affected consumers, data, state,
ordering, and failure paths.

Always preserve and adjust `// fork_change` markers during conflict resolution so
fork modifications remain clearly annotated.

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
- Verify placements with `bun run script/fork-audit.ts --worktree <file>` and
  prettier before folding fixes into the annotation commit; the committed audit
  reads HEAD and silently ignores uncommitted edits.

For `bun.lock` conflicts, never resolve manually; use:

```bash
git checkout --theirs bun.lock
bun install
```

**If upstream independently implements the same or an overlapping feature, stop before
choosing a resolution.** The coordinator must compare the resulting user-facing
contract, behavior, maintenance cost, and relevant tests, then present `ours`,
`upstream`, or a minimal merge to the user. Do not assume the fork implementation
wins; upstream may be the better implementation.

The coordinator may resolve a clear non-overlapping case, prioritizing confirmed fork
behavior.
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
  contracts actually affected by the rebased fork commits or conflict resolutions.
- For VS Code-only changes, run from `packages/kilo-vscode/`:

  ```bash
  bun run typecheck
  bun run lint
  bun test tests/unit/<affected>.test.ts --dots
  ```

  Run targeted unit tests for affected paths. Do not run unrelated CLI, JetBrains,
  docs, gateway, or repository-wide test suites for a VS Code-only change.
- For CLI, server, or shared changes, use the package-specific checks and affected
  tests listed in `AGENTS.md`; do not run unrelated package suites.
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
preservation. Choose the regression-review depth by the risk of the rebase:

- For docs/config/format-only changes or a conflict-free rebase with no substantive
  executable overlap, use a lightweight review: inspect the range-diff and changed
  paths, then run only checks relevant to those paths. Do not launch a multi-agent
  behavioral investigation for a simple case.
- Use deep review only for substantive conflict resolutions, overlapping executable
  behavior, state/lifecycle/timing changes, cross-package contracts, or a broad
  executable-file intersection. Dispatch several read-only agents: one compares
  each original commit with its replay (`git show <old>` vs `git show <new>`), and
  one adversarial agent inspects the merged regions in the final tree.
- Compare against BOTH baselines when classifying: the pre-rebase fork HEAD and
  the new `upstream/main`.
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
- Run the affected package's default unit suite when substantive executable package
  behavior is in scope (for VS Code: `bun run test:unit` from
  `packages/kilo-vscode/`). Do not require a package behavior suite for
  docs/config/format-only changes.
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
