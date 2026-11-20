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
  snake_case, dotted, plural, Go `:=`), the extended names (`auth`, `credential`, `password`, `passwd`,
  `private_key`), near-miss names that must stay untouched, values that are not key-shaped, known
  prefixes (including `ASIA`, `glpat-`, `npm_`, `pypi-`, `dop_v1_`, `cf*`, `NRAK-`, `SG.`, `hvs.`,
  Terraform `<id>.atlasv1.<secret>`), `Authorization` credentials, URL userinfo, and private key blocks.
- `password`, `passwd`, and `pwd` accept any explicit literal value, not only the key shape.
  The all-caps shell variable `PWD` is excluded. A literal
  default such as `changeme` is still a credential. Skipped: empty values, `${...}` templates,
  unquoted `$VAR` references, `<...>` placeholders, member references (`process.env.X`), and
  unquoted type or boolean words (`string`, `boolean`, `false`, ...). A quoted `"$literal"` is masked.
- `credential` and `credentials` stay on the key shape because they often name an option or an object.
- An `email:password` pair masks only the password after the colon. A password shorter than six characters,
  without a digit, or containing a path slash is not treated as a pair, so ports and clone URLs stay intact.
- Qualified aliases add `openai key`, `storage account key`, `dd app key`, and `license key`. The exact
  `AccountKey` field is recognized inside a `;`-separated connection string.
- A near-miss case (`group: "near-miss"` or `"value-shape"`) expects `expected === input`.
- `clean/` must stay unchanged when the corpus is scanned file by file. Do not "fix" a clean file by
  adding an allowance; a changed clean file is a regression report.
- `write-cases.json` expects `blocksWrite(old, next)`, i.e. "writing `next` over `old` would hide a key
  with `[redacted]`". Deletions and edits that keep every key expect `false`.

## Known gaps (not enforced)

These shapes are deliberately not in the corpus because the current rule does not catch them. Adding
them as unchanged cases would bless a leak; adding them as redacted cases would fail. Treat them as
follow-up work:

- Secrets with no fixed prefix are recognized through the assignment name. Conventional names work:
  `AWS_SECRET_ACCESS_KEY`, `AWS_SECRET_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_KEY`,
  `AZURE_STORAGE_ACCOUNT_KEY`, `DD_API_KEY`, `DD_APP_KEY`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`,
  `LICENSE_KEY`. Remaining gaps:
  - a bare value with no assignment (a 40-character AWS secret, a 32-character hex Datadog or Twilio
    token), which is indistinguishable from a hash or an ID;
  - a value that is all letters, all digits, or contains dots.
- Names outside the alias list that end in bare `key` are not recognized.
- `Basic` credentials more than 256 characters after `Authorization`, or on a different line, are not
  associated with the header.
- A trailing sentence period after `Basic <base64>` enters the candidate and fails the base64 check.
- The lexical rule treats UUIDs and base64 fixture data under a sensitive name as keys.
- `max_tokens` matches the grammar because it ends with `tokens`; numeric values stay only because of
  the value-shape check.
- An unterminated private key block redacts to the end of the input (fail closed) instead of being left
  unchanged.
- Twilio `SK`/`AC` SIDs and Stripe `pk_live_` are identifiers or publishable keys, so they are not
  treated as secrets.

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
