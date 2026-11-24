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
- Strong names (`api_key`, `secret_key`, `client_secret`, `access_key`, `private_key`, `signing_key`,
  `encryption_key`, `auth_token`, `api_token`, `access_token`, `refresh_token`, `session_token`, `token`,
  `secret`) accept a 16+ character value without whitespace, dots, or parentheses and with at least one
  letter. This catches letter-only values such as `API_KEY=abcdefghijklmnop`; numeric-only values and
  short placeholders stay readable. `PUBLIC_KEY` and `CACHE_KEY` are not strong names.
- An `email:password` pair masks only the password after the colon. A password shorter than six characters,
  without a digit, containing a path slash, or containing whitespace is not treated as a pair, so ports,
  dates used as prose, and clone URLs stay intact for those shapes.
- Qualified aliases add `openai key`, `storage account key`, `dd app key`, and `license key`. The exact
  `AccountKey` field is recognized inside a `;`-separated connection string.
- The scanner also reads CLI flags (`--password value`, `mysql -p...`, `curl -u user:pass`), `.pgpass`
  and `.netrc` lines, `setx`, YAML block scalars, triple quotes, and `$(...)` substitutions.
- A `.pgpass` row needs a numeric or `*` port and non-empty database and user fields without spaces.
  Search output (`file:line:text`) never reads a relative file path as the host: only a complete row
  after the prefix is masked, so code and CI lines with `::` stay readable.
- `-u user:pass` and `--user user:pass` count after `curl` in the same command, including lines continued
  with a backslash, backtick, or caret, or on a flag line with no command (`.curlrc`). docker, rsync,
  and az use `-u` for a user and group, an update flag, or a URL, and a `scheme://` value is never a
  password.
- Query parameters stop at `&`/`#`, bracketed names (`password[]=`) keep the key, and `db.PWD`/`env.PWD`
  stay readable. Unquoted status words (`enabled`, `required`, `none`, ...) are not treated as passwords.
- Additional prefixes: Google OAuth `GOCSPX-`, Shopify `shpat_`, Linear `lin_api_`, Replicate `r8_`,
  Perplexity `pplx-`, Square `sq0csp-`, age `AGE-SECRET-KEY-`, Mailgun `key-`, Notion `secret_`,
  Discord and Telegram tokens.
- Newer families are covered by `capture.test.ts` and `outbound-redaction.test.ts` rather than static
  corpus rows: OpenCode `oc_sk_`, AWS `A3T`/`ABIA`/`ACCA`, Bedrock `ABSK`, DigitalOcean `doo_v1_`/
  `dor_v1_`, Doppler `dp.pt.`, Databricks `dapi`, Stripe/Clerk `sk_test_`/`sk_prod_`/`rk_*`, dotted
  GitLab, Stripe `whsec_`, Supabase `sb_secret_`, Notion `ntn_`, Sentry `sntry*`, Vercel `vck_`,
  Cloudflare `cfoat_`, RunPod `rpa_`, Fireworks `fw_`, Hugging Face `api_org_`, and Slack webhook URLs.
- Context carriers: `Authorization: Token`/`Api-Key`, `--api-key`/`--auth-token`, `KILO_AUTH_CONTENT`,
  `SERVICE_ROLE_KEY`/`SUPABASE_SERVICE_ROLE_KEY` including prefixed spellings, and `SUPABASE_SERVICE_KEY`
  are recognized in addition to the named assignments. Other names ending in `SERVICE_KEY` mask only
  key-shaped values, and names written with spaces (`service role key:`) are treated as prose.
- Signed URL fields (`sig=`, `X-Amz-Signature=`, `X-Amz-Credential=`, `X-Amz-Security-Token=`),
  AWS SigV4 `Signature=`, Cookie values (`session`, `sessionid`, `connect.sid`, `auth`), and
  letters-only `X-Api-Key` values of at least 16 characters are masked.
- A near-miss case (any group containing `near-miss`, or `value-shape`) expects `expected === input`.
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
- Opaque vendor tokens without a prefix or a recognized name: PayPal, Mistral, Cohere, Together,
  ElevenLabs, Kaggle, Weights & Biases, WireGuard, and PGP private-key blocks.
- Base64 blobs are not decoded: Kubernetes `data`, Docker `auth`, and short base64 credentials pass.
- XML `<add key="Password" value="...">`, positional arguments for arbitrary tools, and raw JSON arrays
  do not propagate the property name, so they stay readable. Recognized flag names such as
  `--password value` are supported.
- An `email:password` pair with a letters-only password, fewer than six characters, or a space is not
  masked. A date-shaped value such as `2024-01-01` is treated as a password when it follows an email
  address. A `password` status word with unusual spelling may be masked as a literal.
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

## Accepted limitations

These are deliberate trade-offs after review, not open bugs:

- Ambiguous literals are masked conservatively: `password: Password` (a type), `password: mandatory`
  (a status word), `pwd: /home/user123456789` (a path), and `deploy@example.com:release123` (which can
  be an scp target or an email/password pair) are treated as credentials. Global type, status, path,
  or username exemptions would expose real passwords.
- Broad standalone shapes can match non-secrets: Discord-like tokens, `key-...`, and `secret_...` do
  not use an entropy threshold, because entropy would reject real credentials as often as identifiers.
- Text with a second escape layer, arbitrary shell syntax, binary payloads, and values beyond the
  scan windows are outside the guarantee. The simple quoted `$()` subset is supported; the filter does
  not decode JSON or shell.
- `blocksWrite` protects a recognized value replaced by `[redacted]` in the same slot. It is not a
  general edit-safety guarantee for arbitrary rewrites or moved credentials.
- A `.pgpass` row with an empty database or user field, or with a space in either, is not masked.
  Search output and code lines have the same shape, and masking them hid readable code.
- `-u user:pass` after a curl wrapper whose name does not contain `curl` is not masked, because other
  tools use the same flag for user and group names, update flags, and URLs.

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
