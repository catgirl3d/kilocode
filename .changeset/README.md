# Changesets

This directory contains changeset files used to track changes for the next release.

## Adding a changeset

When making a user-facing change, prefer one concise changeset per PR, grouping related changes when possible. Run:

```sh
bunx changeset add
```

Or manually create a file `.changeset/<slug>.md`:

```md
---
"kilo-code": minor
---

Short description of the change for the changelog.
```

Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes.

Changeset files support the upstream package release flow. The fork's `publish-vscode-release.yml` workflow deliberately leaves them untouched and requires a reviewed top section in `packages/kilo-vscode/CHANGELOG.md` as its single source of truth for user-facing VSIX release notes.
