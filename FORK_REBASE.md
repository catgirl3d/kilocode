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
upstream intent, and fork intent. Determine whether the changes implement one
contract or independent changes, then trace affected consumers, data, state,
ordering, and failure paths.

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
- After a non-trivial resolution, send the current diff to review subagents and
  critically assess their findings.
- Keep `AGENTS.md` as the source of truth for additional affected guards.
- If rebased changes affect server endpoints in `packages/opencode/src/server/`, run `./script/generate.ts` from the repository root and verify the generated SDK changes.
- Check every fork feature affected by the rebase.
- For CI, inspect `trigger -> conditions -> needs -> runner -> required status`.

Finish only when the working tree is clean, `git diff --check upstream/main..main`
passes, the range-diff has been reviewed, and this tracked-file conflict-marker
scan has empty output and exits 1 as expected:

```bash
git grep -nE '^(<{7}|\|{7}|={7}|>{7})( |$)'
```

`zdiff3` helps show the common base in a conflict; it does not validate behavior.
