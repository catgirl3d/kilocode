# Redaction corpus fixture

Synthetic inputs for `MemoryRedact` values mode. **Every value here is fake.** Nothing in this
directory is a real credential or was taken from a real file.

## Files

| File | Shape |
|---|---|
| `text-cases.json` | `{ "cases": [{ "id", "group", "input", "expected" }] }` for `MemoryRedact.text(input, { values: true })` |
| `write-cases.json` | `{ "cases": [{ "id", "old", "next", "expected" }] }` for `MemoryRedact.blocksWrite(old, next)` |
| `clean/` | Whole files that values mode must return **byte-for-byte unchanged** |
| `verify.ts` | Read-only checker: runs every case and the clean corpus against the current implementation |

`expected` is the **exact** output string. The redaction marker is `[redacted]`.

## Contract

- `text-cases.json` covers the rule grammar, not formatting luck: named values (quoted, bare, camelCase,
  snake_case, dotted, plural), near-miss names that must stay untouched, values that are not key-shaped,
  known prefixes, `Authorization` credentials, and private key blocks.
- A near-miss case (`group: "near-miss"` or `"value-shape"`) expects `expected === input`.
- `clean/` must stay unchanged when the corpus is scanned file by file. Do not "fix" a clean file by
  adding an allowance; a changed clean file is a regression report.
- `write-cases.json` expects `blocksWrite(old, next)`, i.e. "writing `next` over `old` would hide a key
  with `[redacted]`". Deletions and edits that keep every key expect `false`.

## Using it

```bash
# from packages/kilo-memory
bun run test/fixtures/redaction/verify.ts
```

The checker prints one line per mismatch and exits non-zero if any expectation disagrees with the
current implementation. A test can import the same JSON and iterate it; do not copy the cases into
the test, and do not derive expectations from the implementation.

Keep new cases synthetic and keep the fixture declarative: input plus expected output, no helper that
re-implements the matcher.
