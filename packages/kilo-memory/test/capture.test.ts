import { describe, expect, test } from "bun:test"
import {
  capturePlan,
  duplicateOps,
  errorReason,
  fallbackDigest,
  guardReason,
  hasSubstantialDiff,
  hasUserEdit,
  mergeOps,
  notice,
  parseJson,
  parseDigest,
  parseOps,
  salvageTyped,
  skipLine,
  summarizeDiffs,
  typedSchema,
  verifySkips,
  digestSchema,
} from "../src/capture/capture"
import { MemoryOperations } from "../src/capture/operations"
import { MemoryRedact } from "../src/capture/redact"

describe("memory capture parsing", () => {
  test("parses fenced json text from model output", () => {
    const parsed = parseJson(digestSchema, '```json\n{"topic":"repo setup","summary":"Run package tests."}\n```')

    expect(parsed).toEqual({ topic: "repo setup", summary: "Run package tests." })
  })

  test("ignores additional digest fields from model output", () => {
    const parsed = parseJson(
      digestSchema,
      JSON.stringify({
        topic: "repo setup",
        summary: "Run package tests.",
        next_step: "Open a pull request.",
        blockers: [],
      }),
    )

    expect(parsed).toEqual({ topic: "repo setup", summary: "Run package tests." })
  })

  test("maps consolidation operation names into deterministic memory operations", () => {
    const parsed = parseJson(
      typedSchema,
      JSON.stringify({
        operations: [
          { op: "upsert_project_fact", key: "repo_tests", value: "Run tests from packages/opencode." },
          {
            op: "upsert_project_decision",
            key: "file_store",
            value: "Keep memory v0 file-based before adding databases.",
          },
          { op: "upsert_project_constraint", key: "zod_only", value: "The memory package stays zod-only." },
          { op: "upsert_environment_fact", section: "tooling", key: "bun", value: "Use bun for package scripts." },
          { op: "append_correction", key: "root_tests", value: "Do not run bun test from the repo root." },
          { op: "remove_memory", query: "old_memory" },
          { op: "noop", key: "ignored", value: "ignored" },
        ],
        skipped: [{ reason: "duplicate", text: "already saved" }],
      }),
    )

    expect(parseOps(parsed)).toEqual([
      {
        action: "add",
        file: "project.md",
        section: "Facts",
        key: "repo_tests",
        text: "Run tests from packages/opencode.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Decisions",
        key: "file_store",
        text: "Keep memory v0 file-based before adding databases.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Constraints",
        key: "zod_only",
        text: "The memory package stays zod-only.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "bun",
        text: "Use bun for package scripts.",
      },
      {
        action: "add",
        file: "corrections.md",
        section: "Corrections",
        key: "root_tests",
        text: "Do not run bun test from the repo root.",
      },
      { action: "remove", query: "old_memory" },
    ])
    expect(parsed.skipped).toEqual([{ reason: "duplicate", text: "already saved" }])
  })

  test("salvages valid ops from a partially malformed typed batch with model preamble", () => {
    const tooLong = "x".repeat(2_100)
    const parsed = salvageTyped(
      "Here is the JSON you asked for:\n" +
        `{"operations":[` +
        `{"op":"upsert_project_fact","key":"good_one","value":"Keep this fact."},` +
        `{"op":"not_a_real_op","key":"nope","value":"unknown op is salvaged"},` +
        `{"op":"upsert_project_fact","key":"too_long","value":"${tooLong}"},` +
        `{"op":"upsert_project_decision","key":"good_two","value":"Keep this decision."}` +
        `],"skipped":[{"reason":"duplicate","text":"already saved"}]}`,
    )

    // The two well-formed ops survive; the unknown op and the over-length value are salvaged, not fatal.
    expect(parseOps(parsed).map((op) => (op.action === "add" ? op.key : op.action))).toEqual(["good_one", "good_two"])
    expect(parsed.skipped.filter((item) => item.reason === "unsupported")).toHaveLength(2)
    expect(parsed.skipped.some((item) => item.reason === "duplicate")).toBe(true)
  })

  test("throws on valid JSON that has no operations array instead of silently returning an empty batch", () => {
    expect(() => salvageTyped(`[{"op":"upsert_project_fact","key":"good_one","value":"Keep this fact."}]`)).toThrow()
    expect(() => salvageTyped(`{"op":"upsert_project_fact","key":"good_one","value":"Keep this fact."}`)).toThrow()
  })

  test("redacts secrets in salvaged unsupported ops before they reach callers", () => {
    const parsed = salvageTyped(
      `{"operations":[{"op":"not_a_real_op","key":"leak","value":"key is sk-abcdefghijklmnopqrstuvwxyz"}],"skipped":[]}`,
    )

    const salvaged = parsed.skipped.find((item) => item.reason === "unsupported")
    expect(salvaged?.text).toContain("[redacted]")
    expect(JSON.stringify(parsed.skipped)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
  })

  test("redacts secrets in model-emitted skips before they reach callers", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz"
    const parsed = salvageTyped(
      `{"operations":[],"skipped":[{"reason":"unsupported","text":"model skipped ${secret}"}]}`,
    )

    expect(parsed.skipped[0]?.text).toContain("[redacted]")
    expect(parsed.skipped[0]?.text).not.toContain(secret)
  })

  test("salvages non-empty sibling fields when typed op value is empty", () => {
    const parsed = salvageTyped(
      `{"operations":[{"op":"not_a_real_op","key":"fallback key text","value":""}],"skipped":[]}`,
    )

    expect(parsed.skipped).toContainEqual({ reason: "unsupported", text: "fallback key text" })
  })

  test("redacts a secret that straddles the 500-char salvage truncation boundary", () => {
    const secret = "sk-" + "a".repeat(40)
    // Positioned so truncate-then-redact would leave only "sk-" + 19 a's — below the regex's {20,} minimum.
    const padding = "x".repeat(478)
    const value = padding + secret
    const parsed = salvageTyped(`{"operations":[{"op":"not_a_real_op","key":"leak","value":"${value}"}],"skipped":[]}`)

    const salvaged = parsed.skipped.find((item) => item.reason === "unsupported")
    expect(salvaged?.text.length ?? 0).toBeLessThanOrEqual(500)
    expect(JSON.stringify(parsed.skipped)).not.toContain(secret)
    expect(JSON.stringify(parsed.skipped)).not.toContain(secret.slice(0, 20))
  })

  test("truncates typed batches beyond the op cap instead of failing", () => {
    const ops = Array.from(
      { length: 20 },
      (_, idx) => `{"op":"upsert_project_fact","key":"k_${idx}","value":"Fact ${idx} body."}`,
    ).join(",")
    const parsed = salvageTyped(`{"operations":[${ops}],"skipped":[]}`)

    expect(parsed.operations).toHaveLength(16)
  })

  test("reconcile supersedes and honors only exact-key removes", () => {
    const keys = new Set(["project.md:Facts:stale_fact", "stale_fact", "kept_fact"])
    const reconciled = MemoryOperations.reconcile({
      keys,
      ops: [
        // Add updating an existing key → keep the add.
        { action: "add", file: "project.md", section: "Facts", key: "kept_fact", text: "Updated value." },
        // Remove superseded by a same-batch add on the same key → dropped (the add updates it).
        { action: "add", file: "project.md", section: "Facts", key: "replaced", text: "New value." },
        { action: "remove", query: "replaced" },
        // File-qualified supersede keys trim generated key whitespace too.
        { action: "add", file: "project.md", section: "Facts", key: " replaced_file ", text: "New file value." },
        { action: "remove", query: "project.md:Facts:replaced_file" },
        // Exact existing key with no replacing add → kept as a bounded removal.
        { action: "remove", query: "stale_fact" },
        // Fuzzy query that matches no existing key → dropped (hard removes stay explicit-only).
        { action: "remove", query: "something the model paraphrased" },
      ],
    })

    expect(reconciled.ops.map((op) => op.key)).toEqual(["kept_fact", "replaced", " replaced_file "])
    expect(reconciled.removes).toEqual([{ action: "remove", query: "stale_fact" }])
  })

  test("merges fallback typed operations without duplicates", () => {
    const ops = mergeOps([
      { action: "add", file: "environment.md", section: "Commands", key: "tests", text: "Run bun test." },
      { action: "add", file: "environment.md", section: "Commands", key: "tests", text: "Run bun test again." },
      { action: "remove", query: "stale" },
      { action: "remove", query: "stale" },
    ])

    expect(ops).toEqual([
      { action: "add", file: "environment.md", section: "Commands", key: "tests", text: "Run bun test." },
      { action: "remove", query: "stale" },
    ])
  })

  test("filters self-referential generated adds", () => {
    const fact = {
      action: "add",
      file: "project.md",
      section: "Facts",
      key: "memory_index",
      text: "Memory index records are rebuilt from project source files.",
    } satisfies MemoryOperations.Op
    const filtered = duplicateOps({
      items: [],
      skipped: [],
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "memory_echo",
          text: "Small model call-site behavior is already in project memory.",
        },
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "scope_review",
          text: "Config preference scope/write behavior was investigated.",
        },
        fact,
      ],
    })

    expect(filtered.ops).toEqual([fact])
    expect(filtered.skipped.map((item) => item.reason)).toEqual(["self_referential", "self_referential"])
    expect(MemoryOperations.reject(fact)).toBeUndefined()
  })

  test("filters instruction provenance generated adds", () => {
    const fact = {
      action: "add",
      file: "project.md",
      section: "Facts",
      key: "repo_test_rule",
      text: "Root AGENTS.md says to run package-level tests instead of root bun test.",
    } satisfies MemoryOperations.Op
    const filtered = duplicateOps({
      items: [],
      skipped: [],
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "instruction_sources",
          text: "Sources: system/developer instructions, AGENTS.md, packages/opencode/AGENTS.md, and ~/.claude/CLAUDE.md.",
        },
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "user_context",
          text: "~/.claude/CLAUDE.md is user-level context for concise replies.",
        },
        fact,
      ],
    })

    expect(filtered.ops).toEqual([fact])
    expect(filtered.skipped.map((item) => item.reason)).toEqual(["out_of_scope", "out_of_scope"])
  })

  test("parses project-only skip reasons", () => {
    const parsed = parseJson(
      typedSchema,
      JSON.stringify({
        operations: [{ op: "noop" }],
        skipped: [
          { reason: "out_of_scope", text: "User prefers concise commit messages." },
          { reason: "self_referential", text: "Existing memory already tracks the test command." },
        ],
      }),
    )

    expect(parseOps(parsed)).toEqual([])
    expect(parsed.skipped.map((item) => item.reason)).toEqual(["out_of_scope", "self_referential"])
    expect(skipLine([parsed.skipped[0]!])).toBe("reason=out_of_scope")
  })

  test("plans capture cadence from a state table", () => {
    const base = {
      summary: "User: continue implementing digest robustness Result: updated capture and storage behavior",
      echo: false,
      substantial: false,
      edited: false,
      priorTime: 0,
      now: 1_000,
      minIntervalMs: 500,
      lastTypedConsolidationAt: undefined,
      autoConsolidate: true,
    }
    const cases = [
      {
        name: "expected work: completed turn schedules digest and typed capture",
        input: base,
        expected: { session: true, digestDue: true, typedCall: true, typedWork: true, skipReason: undefined },
      },
      {
        name: "expected work: a persisted null typed clock does not throttle capture",
        input: { ...base, lastTypedConsolidationAt: null },
        expected: { session: true, digestDue: true, typedCall: true, typedWork: true, skipReason: undefined },
      },
      {
        name: "expected idle flush: completed turn inside interval skips now",
        input: { ...base, priorTime: 900, lastTypedConsolidationAt: 900 },
        expected: { digestDue: false, typedCall: false, skipReason: "interval", idleFlush: true },
      },
      {
        name: "expected work: bypass interval lets idle flush run typed capture",
        input: { ...base, priorTime: 900, lastTypedConsolidationAt: 900, bypassInterval: true },
        expected: { digestDue: false, typedCall: true, skipReason: undefined, idleFlush: false },
      },
      {
        name: "expected work: recall echo skips digest but still runs typed capture",
        input: { ...base, echo: true },
        expected: { session: false, digestDue: false, typedCall: true, typedWork: true, skipReason: undefined },
      },
      {
        name: "expected work: recall-assisted substantial answer is modeled as non-echo by caller",
        input: { ...base, substantial: true },
        expected: { session: true, digestDue: true, typedCall: true, skipReason: undefined },
      },
      {
        name: "expected skip: interrupted turn still schedules a non-LLM fallback digest",
        input: { ...base, reason: "interrupted" as const, substantial: true },
        expected: {
          completed: false,
          session: false,
          digestDue: false,
          typedCall: false,
          fallbackDigest: true,
          skipReason: "no_work",
        },
      },
      {
        name: "expected skip: errored turn still schedules a non-LLM fallback digest",
        input: { ...base, reason: "error" as const },
        expected: {
          completed: false,
          session: false,
          digestDue: false,
          typedCall: false,
          fallbackDigest: true,
          skipReason: "no_work",
        },
      },
      {
        name: "expected skip: auto consolidation disabled",
        input: { ...base, autoConsolidate: false },
        expected: { session: false, digestDue: false, typedCall: false, typedWork: false, skipReason: "no_work" },
      },
      {
        name: "expected skip: no summary means no work",
        input: { ...base, summary: "" },
        expected: { session: false, digestDue: false, typedCall: false, typedWork: false, skipReason: "no_work" },
      },
      {
        name: "expected skip: trivial completed turn writes no digest when typed is interval-gated",
        input: { ...base, summary: "User: test Result: ok", lastTypedConsolidationAt: 900 },
        expected: { digestDue: false, typedCall: false, fallbackDigest: false, skipReason: "trivial" },
      },
      {
        name: "expected skip: short edited turn is interval-gated instead of trivial",
        input: {
          ...base,
          summary: "User: test Result: ok",
          edited: true,
          priorTime: 900,
          lastTypedConsolidationAt: 900,
        },
        expected: { digestDue: false, typedCall: false, fallbackDigest: false, skipReason: "interval" },
      },
      {
        name: "expected skip: short unedited turn is trivial",
        input: { ...base, summary: "User: test Result: ok", edited: false, lastTypedConsolidationAt: 900 },
        expected: { digestDue: false, typedCall: false, fallbackDigest: false, skipReason: "trivial" },
      },
    ]

    for (const item of cases) {
      expect(capturePlan(item.input), item.name).toMatchObject(item.expected)
    }
  })

  test("summarizes durable diffs and fallback digests", () => {
    const diffs = [
      { file: "src/index.ts", status: "modified", additions: 1, deletions: 1 },
      { file: "README.md", status: "modified", additions: 1, deletions: 0 },
    ]

    // Identical churn yields the identical verdict across every kind of path, so no ecosystem
    // (manifest, doc, config, or source language) is treated specially.
    for (const file of [
      "src/app.ts",
      "src/app.py",
      "src/app.go",
      "src/app.rb",
      "package.json",
      "docs/x.md",
      "config.yaml",
    ]) {
      expect(hasSubstantialDiff([{ file, additions: 1, deletions: 0 }]), `${file} small`).toBe(false)
      expect(hasSubstantialDiff([{ file, additions: 20, deletions: 0 }]), `${file} large`).toBe(true)
    }
    // A split edit still counts by total churn.
    expect(hasSubstantialDiff([{ file: "internal/server/main", additions: 12, deletions: 10 }])).toBe(true)
    // Build output never counts, even with heavy churn.
    expect(hasSubstantialDiff([{ file: "dist/bundle.js", additions: 200, deletions: 0 }])).toBe(false)
    expect(hasSubstantialDiff([{ file: "src/generated/client.ts", additions: 200, deletions: 0 }])).toBe(false)
    expect(hasSubstantialDiff([{ file: "sdk/src/gen/types.gen.ts", additions: 200, deletions: 0 }])).toBe(false)
    // Binary edits report 0/0 churn, so they are never substantial (but still count as work below).
    expect(hasSubstantialDiff([{ file: "assets/logo.png", additions: 0, deletions: 0 }])).toBe(false)
    // hasUserEdit: any non-generated file changed counts as work, in any language; presence, not churn.
    expect(hasUserEdit([])).toBe(false)
    expect(hasUserEdit([{ additions: 1, deletions: 0 }])).toBe(false)
    expect(hasUserEdit([{ file: "src/app.ts", additions: 1, deletions: 0 }])).toBe(true)
    expect(hasUserEdit([{ file: "dist/bundle.js", additions: 300, deletions: 0 }])).toBe(false)
    expect(hasUserEdit([{ file: "assets/logo.png", additions: 0, deletions: 0 }])).toBe(true)
    expect(summarizeDiffs(diffs)).toContain("modified README.md +1 -0")
    expect(fallbackDigest({ prior: "Earlier state.", summary: "New state.", max: 80 })).toContain("Latest: New state.")
    expect(parseDigest({ topic: "", summary: "User: x Result: y." }, "", 120).topic).not.toBe("User")
  })

  test("verifies duplicate skips and operation duplicates", () => {
    const items = [
      {
        id: "project.md:Facts:repo_tests",
        file: "project.md" as const,
        section: "Facts",
        key: "repo_tests",
        text: "repo_tests Run memory tests from packages/opencode.",
      },
    ]
    const verified = verifySkips({
      items,
      skipped: [
        // Fully scoped to the stored entry → confirmed.
        { reason: "duplicate", text: "Run memory tests from packages/opencode.", file: "project.md", section: "Facts" },
        // Unscoped → unverified regardless of any text overlap.
        { reason: "duplicate", text: "New durable workflow preference." },
      ],
    })
    const deduped = duplicateOps({
      items,
      skipped: verified.skipped,
      ops: [
        // Same file/section/key as an existing entry, changed value → an upsert update, not a duplicate.
        { action: "add", file: "project.md", section: "Facts", key: "repo_tests", text: "Run memory tests." },
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "new_preference",
          text: "New durable workflow preference.",
        },
      ],
    })

    expect(verified.skipped[0]?.duplicateOf).toBe("project.md:Facts:repo_tests")
    expect(verified.skipped).toContainEqual({ reason: "unsupported", text: "New durable workflow preference." })
    // The exact-key upsert is kept (routed to apply as an update); the new fact is kept too.
    expect(deduped.ops).toEqual([
      { action: "add", file: "project.md", section: "Facts", key: "repo_tests", text: "Run memory tests." },
      {
        action: "add",
        file: "project.md",
        section: "Facts",
        key: "new_preference",
        text: "New durable workflow preference.",
      },
    ])
    // The exact-key upsert produces no NEW op-level duplicate skip; the only entry pointing at
    // repo_tests is the model's own confirmed duplicate claim carried through verifySkips.
    expect(deduped.skipped.filter((item) => item.duplicateOf === "project.md:Facts:repo_tests")).toHaveLength(1)
  })

  test("recognizes an exact-key upsert even when the model's key needs slugging", () => {
    const items = [
      {
        id: MemoryOperations.id({
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "Deploy Target",
          text: "",
        }),
        file: "project.md" as const,
        section: "Facts",
        key: "deploy_target",
        text: "deploy_target Deploy to staging.",
      },
    ]
    const deduped = duplicateOps({
      items,
      skipped: [],
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "Deploy Target",
          text: "Deploy to production now.",
        },
      ],
    })

    expect(deduped.ops).toEqual([
      { action: "add", file: "project.md", section: "Facts", key: "Deploy Target", text: "Deploy to production now." },
    ])
    expect(deduped.skipped).toEqual([])
  })

  test("does not pre-skip similar operations from different memory scopes", () => {
    const filtered = duplicateOps({
      items: [
        {
          id: "corrections.md:Corrections:repo_tests",
          file: "corrections.md",
          section: "Corrections",
          key: "repo_tests",
          text: "repo_tests Run memory tests from packages/opencode.",
        },
      ],
      skipped: [],
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "repo_tests",
          text: "Run memory tests from packages/opencode.",
        },
      ],
    })

    expect(filtered.ops).toHaveLength(1)
    expect(filtered.skipped).toEqual([])
  })

  test("scopes model-reported duplicate skips to the claimed file/section", () => {
    const items = [
      {
        id: "corrections.md:Corrections:repo_tests",
        file: "corrections.md" as const,
        section: "Corrections",
        key: "repo_tests",
        text: "repo_tests Run memory tests from packages/opencode.",
      },
    ]
    const verified = verifySkips({
      items,
      skipped: [
        // Claims a duplicate in project.md/Facts, but the only match lives in corrections.md →
        // unconfirmed, downgraded to advisory instead of confirmed cross-scope.
        {
          reason: "duplicate",
          text: "Run memory tests from packages/opencode.",
          file: "project.md",
          section: "Facts",
        },
        // Same text, correctly scoped to where the entry actually lives → confirmed.
        {
          reason: "duplicate",
          text: "Run memory tests from packages/opencode.",
          file: "corrections.md",
          section: "Corrections",
        },
      ],
    })

    expect(verified.skipped[0]).toMatchObject({ reason: "unsupported" })
    expect(verified.skipped[1]).toMatchObject({
      reason: "duplicate",
      duplicateOf: "corrections.md:Corrections:repo_tests",
    })
  })

  test("does not confirm a duplicate skip scoped to a file without a section", () => {
    const items = [
      {
        id: "project.md:Decisions:repo_tests",
        file: "project.md" as const,
        section: "Decisions",
        key: "repo_tests",
        text: "repo_tests Run memory tests from packages/opencode.",
      },
    ]
    const verified = verifySkips({
      items,
      skipped: [
        // Claims project.md but not the section; the only match lives in Decisions. Confirming would
        // risk a cross-section false positive, so it must downgrade to advisory.
        { reason: "duplicate", text: "Run memory tests from packages/opencode.", file: "project.md" },
      ],
    })

    expect(verified.skipped[0]).toEqual({
      reason: "unsupported",
      text: "Run memory tests from packages/opencode.",
    })
  })

  test("builds capture notices and guard summaries", () => {
    const ops = [
      { action: "add", file: "environment.md", section: "Commands", key: "tests", text: "Run bun test." },
    ] as const

    expect(notice({ count: 1, ops: [...ops], skipped: [], tokens: 12 })).toMatchObject({
      type: "saved",
      message: "Memory saved · environment.md:tests",
      files: ["environment.md"],
    })
    expect(
      notice({ count: 0, ops: [], skipped: [{ reason: "duplicate", duplicateOf: "project.md:tests" }], tokens: 3 }),
    ).toMatchObject({ type: "skipped", skippedCount: 1 })
    expect(skipLine([{ reason: "duplicate", duplicateOf: "project.md:tests" }])).toBe(
      "reason=duplicate duplicateOf=project.md:tests",
    )
    expect(guardReason("429 too many requests")).toBe("rate_limit_guard")
    expect(guardReason("billing credits exhausted")).toBe("quota_guard")
    expect(guardReason("request timed out")).toBe("transient")
    expect(guardReason("deadline exceeded")).toBe("transient")
    expect(guardReason("DeadlineExceeded")).toBe("transient")
    expect(guardReason('cause={"code":"ETIMEDOUT"}')).toBe("transient")
    expect(guardReason("504 Gateway Timeout")).toBe("transient")
    expect(guardReason("Connect Timeout Error")).toBe("transient")
    expect(guardReason("Headers Timeout Error")).toBe("transient")
    expect(guardReason("Body Timeout Error")).toBe("transient")
    expect(guardReason("connect_timeout")).toBe("transient")
    expect(guardReason('status=400 body={"error":"invalid parameter: timeout"}')).toBeUndefined()
    expect(guardReason("set request timeout to 30000")).toBeUndefined()
    const timeout = new Error("request aborted")
    timeout.name = "TimeoutError"
    expect(guardReason(timeout)).toBe("transient")
    expect(errorReason(timeout)).toBe("request aborted")
    expect(guardReason(Object.assign(new Error("request failed"), { status: 504 }))).toBe("transient")
    expect(
      guardReason(Object.assign(new Error("request failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })),
    ).toBe("transient")
    expect(
      guardReason(Object.assign(new Error("request failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })),
    ).toBe("transient")
    expect(guardReason(Object.assign(new Error("request failed"), { cause: { code: "ETIMEDOUT" } }))).toBe(
      "transient",
    )
    expect(
      guardReason(Object.assign(new Error("failed after 2 attempts"), { errors: [{ statusCode: 504 }] })),
    ).toBe("transient")
    expect(guardReason(new Error("set request timeout to 30000"))).toBeUndefined()
    expect(guardReason(new Error("request timed out"))).toBe("transient")
    expect(guardReason(Object.assign(new Error("request failed"), { cause: new Error("connect timeout") }))).toBe(
      "transient",
    )
    expect(
      guardReason(
        Object.assign(new Error("failed after 2 attempts"), {
          errors: [Object.assign(new Error("rate limit reached"), { status: 429 }), timeout],
        }),
      ),
    ).toBe("rate_limit_guard")
    expect(
      guardReason(
        Object.assign(new Error("failed after 2 attempts"), {
          errors: [new Error("insufficient quota available"), timeout],
        }),
      ),
    ).toBe("quota_guard")
    expect(
      guardReason(
        Object.assign(new Error("request failed"), {
          cause: Object.assign(new Error("rate limit reached"), { status: 429 }),
        }),
      ),
    ).toBe("rate_limit_guard")
    expect(
      guardReason(
        Object.assign(new Error("timed out"), {
          name: "TimeoutError",
          cause: new Error("billing credit balance exhausted"),
        }),
      ),
    ).toBe("quota_guard")
    expect(guardReason("timeout after 429 too many requests")).toBe("rate_limit_guard")
    expect(guardReason("timeout after quota exceeded")).toBe("quota_guard")
  })

  test("redacts common secret token shapes", () => {
    const github = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    const google = "AIzaabcdefghijklmnopqrstuvwxyz123456789"
    const jwt = "eyJabcdefghijklmnopqrstuvwxyz.eyJmnopqrstuvwxyz12345.signaturevalue12345"
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz123456"
    const text = [
      `github=${github}`,
      `google=${google}`,
      `jwt=${jwt}`,
      `Authorization: ${bearer}`,
      "client_secret=super-secret-value",
      "access_key=super-secret-value",
      "refresh_token=abcdefghijklmnopqrstuvwxyz",
      'password="two words"',
      "DATABASE_URL=postgres://alice:hunter2@host/db",
    ].join("\n")
    const redacted = MemoryRedact.text(text)

    expect(MemoryRedact.has(text)).toBe(true)
    expect(redacted).not.toContain(github)
    expect(redacted).not.toContain(google)
    expect(redacted).not.toContain(jwt)
    expect(redacted).not.toContain(bearer)
    expect(redacted.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(9)
    expect(redacted).not.toContain("two words")
    expect(redacted).not.toContain("hunter2")
    expect(MemoryRedact.value({ private_key: "abc", credential: "def", auth: "ghi" })).toEqual({
      private_key: "[redacted]",
      credential: "[redacted]",
      auth: "[redacted]",
    })
  })

  test("redacts URI userinfo credentials", () => {
    const cases = [
      ["postgres://alice:hunter2@db.local/app", "postgres://[redacted]@db.local/app", "hunter2"],
      ["postgresql://alice:p%40ss@db.local/app", "postgresql://[redacted]@db.local/app", "p%40ss"],
      [
        "mongodb+srv://user:secret@cluster.mongodb.net/app",
        "mongodb+srv://[redacted]@cluster.mongodb.net/app",
        "secret",
      ],
      ["redis://:cache-secret@localhost:6379/0", "redis://[redacted]@localhost:6379/0", "cache-secret"],
      ["https://user:pass@example.com/path", "https://[redacted]@example.com/path", "pass"],
    ] as const

    for (const item of cases) {
      const redacted = MemoryRedact.text(item[0])
      expect(MemoryRedact.has(item[0]), item[0]).toBe(true)
      expect(redacted).toBe(item[1])
      expect(redacted).not.toContain(item[2])
    }

    // Unknown/non-allowlisted scheme: parsing, not an enumerated list, decides.
    expect(MemoryRedact.text("clickhouse://svc:topsecret@host:9000/db")).toBe("clickhouse://[redacted]@host:9000/db")

    // Fail closed on any userinfo: a bare user@host (no colon) may still be a token.
    expect(MemoryRedact.has("https://token@host/path")).toBe(true)
    expect(MemoryRedact.text("https://token@host/path")).toBe("https://[redacted]@host/path")

    // Multiple URIs embedded in prose: each userinfo is redacted, surrounding text preserved.
    expect(MemoryRedact.text("primary postgres://u:p@h1/a then cache redis://:s@h2/0 done")).toBe(
      "primary postgres://[redacted]@h1/a then cache redis://[redacted]@h2/0 done",
    )

    // Malformed URL the parser rejects must still redact via the raw-segment fallback.
    const malformed = "postgres://user:leaked@[bad"
    expect(MemoryRedact.has(malformed)).toBe(true)
    expect(MemoryRedact.text(malformed)).not.toContain("leaked")

    // @ in the path or query with no userinfo must not be touched (no false positives).
    expect(MemoryRedact.has("https://example.com/a:b@c")).toBe(false)
    expect(MemoryRedact.text("https://example.com/a:b@c")).toBe("https://example.com/a:b@c")
    expect(MemoryRedact.text("https://example.com/p?to=a@b.com")).toBe("https://example.com/p?to=a@b.com")

    // has() and text() must agree: anything has() flags is actually scrubbed by text().
    for (const item of [...cases.map((c) => c[0]), malformed, "no secrets here", "https://example.com/a:b@c"]) {
      if (MemoryRedact.has(item)) expect(MemoryRedact.text(item), item).not.toBe(item)
    }
  })

  test("assignment redaction avoids prose false positives but still catches real secrets", () => {
    // P1.6: keyword-boundary + secret-shaped-value guards. These prose phrases must NOT redact.
    const clean = ["author: Jane", "auth_mode=none", "the token expiry is 1h", "authored=today", "tokenizer=fast"]
    for (const item of clean) {
      expect(MemoryRedact.has(item), item).toBe(false)
      expect(MemoryRedact.text(item), item).toBe(item)
    }

    // Real secrets (incl. compound underscore keys and short-but-entropic values) still redact.
    // A strong keyword assigned with `:` or `=` redacts even a low-entropy all-letter value, so
    // `secret: enabled` / `password: required` redact too — see redact.ts for the tradeoff.
    const secrets = [
      "password=hunter2",
      "password=hunterx",
      "password: hunterx",
      "passwords: hunterx",
      "secret: enabled",
      "secrets: enabled",
      "password: required",
      "client_secret=super-secret-value",
      "refresh_token=abcdefghijklmnopqrstuvwxyz",
      "refresh_tokens: abcdefghijklmnopqrstuvwxyz",
      "api_key=sk-abcdefghijklmnopqrstuvwxyz",
      "api_keys=sk-abcdefghijklmnopqrstuvwxyz",
      "credentials: abcdefghijklmnopqrstuvwxyz",
    ]
    for (const item of secrets) {
      expect(MemoryRedact.has(item), item).toBe(true)
      const out = MemoryRedact.text(item)
      expect(out, item).toContain("[redacted]")
      // The marker must replace the value, not sit next to it.
      expect(out, item).not.toContain(item.slice(item.search(/[:=]/) + 1).trim())
    }
  })

  test("allowlists git clone-URL userinfo but still redacts credentialed URIs", () => {
    // P1.6: `git@` (no password) is the conventional clone user, not a secret.
    for (const item of ["ssh://git@github.com/org/repo.git", "https://git@github.com/org/repo.git"]) {
      expect(MemoryRedact.has(item), item).toBe(false)
      expect(MemoryRedact.text(item), item).toBe(item)
    }
    // A password on the git user is still a credential.
    expect(MemoryRedact.has("ssh://git:secret@github.com/org/repo.git")).toBe(true)
    expect(MemoryRedact.text("ssh://git:secret@github.com/org/repo.git")).not.toContain("secret")
  })

  test("rejects self-referential/provenance patterns only as whole values, keeping real facts", () => {
    // P1.9: single meta clause is still rejected...
    expect(MemoryOperations.reject({ text: "Config preference scope/write behavior was investigated." })).toMatchObject(
      { reason: "self_referential" },
    )
    // ...but a real fact that merely ends a later clause with "was reviewed" survives.
    expect(
      MemoryOperations.reject({ text: "Refactored auth in src/auth.ts. The retry path was reviewed." }),
    ).toBeUndefined()
    expect(MemoryOperations.reject({ text: "Was auth reviewed? The retry path was checked." })).toBeUndefined()
    expect(MemoryOperations.reject({ text: "Fixed the timeout bug; the retry path was reviewed." })).toBeUndefined()
    expect(MemoryOperations.reject({ text: "Fixed the timeout bug\nthe retry path was reviewed." })).toBeUndefined()

    // A statement whose subject IS the source file is provenance...
    expect(
      MemoryOperations.reject({ text: "~/.claude/CLAUDE.md is user-level context for concise replies." }),
    ).toMatchObject({ reason: "out_of_scope" })
    // ...but a fact that merely cites the file mid-sentence is kept.
    expect(
      MemoryOperations.reject({ text: "Run tests from packages/opencode per the rule in .claude/claude.md." }),
    ).toBeUndefined()
  })
})

describe("memory redact values mode", () => {
  const values = { values: true }
  const marker = "[redacted]"

  test("redacts every prefix key format", () => {
    const keys = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
      "xo" + "xb-123456789012-abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "gsk_abcdefghijklmnopqrstuvwxyz012345",
      "xai-abcdefghijklmnopqrstuvwxyz012345",
      "hf_abcdefghijklmnopqrstuvwxyz012345",
      "sk_" + "live_abcdefghijklmnopqrstuvwx",
      "rk_" + "live_abcdefghijklmnopqrstuvwx",
    ]
    for (const key of keys) {
      const input = `key ${key} here`
      expect(MemoryRedact.has(input, values), key).toBe(true)
      const redacted = MemoryRedact.text(input, values)
      expect(redacted, key).not.toContain(key)
      expect(redacted, key).toContain(marker)
    }
    // A publishable Stripe key is not a secret.
    expect(MemoryRedact.has("pk_live_abcdefghijklmnopqrstuvwxyz012345", values)).toBe(false)
  })

  test("redacts named assignment values, keeping names, separators and quotes", () => {
    const key = "test0123456789abcdef0123456789abc"
    const cases = [
      [`MISTRAL_API_KEY="${key}"`, 'MISTRAL_API_KEY="[redacted]"'],
      [`client_secret: "${key}"`, 'client_secret: "[redacted]"'],
      [`SECRET_KEY=${key}`, "SECRET_KEY=[redacted]"],
      [`const githubToken = "${key}"`, 'const githubToken = "[redacted]"'],
      [`"api_key": "${key}"`, '"api_key": "[redacted]"'],
      [`provider.clientSecretKeys=${key}`, "provider.clientSecretKeys=[redacted]"],
      ['API_KEY = "abcdef1234567890xyz"', 'API_KEY = "[redacted]"'],
      ["OPENAI_API_KEY='abcdef1234567890xyz'", "OPENAI_API_KEY='[redacted]'"],
      ['{"client_secret": "abcdef1234567890xyz"}', '{"client_secret": "[redacted]"}'],
      ["token: abcdef1234567890xyz", "token: [redacted]"],
      ["refresh_token: refreshabcdef1234567890", "refresh_token: [redacted]"],
      ["apiKey: abcdef1234567890xyz", "apiKey: [redacted]"],
      ["access_key = abcdef1234567890xyz", "access_key = [redacted]"],
      ["API_KEY: abcdef1234567890xyz", "API_KEY: [redacted]"],
    ] as const
    for (const [input, expected] of cases) {
      expect(MemoryRedact.has(input, values), input).toBe(true)
      expect(MemoryRedact.text(input, values), input).toBe(expected)
    }
  })

  test("redacts quoted and bare Authorization credentials, keeping the scheme", () => {
    expect(MemoryRedact.text('Authorization="Bearer abcdef1234567890xyz"', values)).toBe(
      'Authorization="Bearer [redacted]"',
    )
    expect(MemoryRedact.text("Authorization: Basic dXNlcjpwYXNzd29yZA==", values)).toBe(
      "Authorization: Basic [redacted]",
    )
    // A short base64 user:pass with no digit or padding is still a credential under an Authorization
    // header, while prose that merely names the scheme stays intact.
    expect(MemoryRedact.has("Authorization: Basic dXNlcjpwYXNz", values)).toBe(true)
    expect(MemoryRedact.text("Authorization: Basic dXNlcjpwYXNz", values)).toBe("Authorization: Basic [redacted]")
    expect(MemoryRedact.has("Basic authentication is required", values)).toBe(false)
    expect(MemoryRedact.text("Basic authentication is required", values)).toBe("Basic authentication is required")
    expect(MemoryRedact.text(`Authorization: Bearer abcdefghijklmnop123456`, values)).toBe(
      "Authorization: Bearer [redacted]",
    )
  })

  test("hides a private key block whole", () => {
    const block = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEabcdefgh12345678", "-----END RSA PRIVATE KEY-----"].join("\n")
    expect(MemoryRedact.text(`before\n${block}\nafter`, values)).toBe("before\n[redacted]\nafter")
  })

  test("handles escaped quotes and line continuation across the whole value", () => {
    expect(MemoryRedact.text(`API_KEY="abc\\"def1234567890\\"ghi"`, values)).toBe(`API_KEY="[redacted]"`)
    const continued = 'API_KEY="abc\\\n1234567890abcdef"'
    expect(MemoryRedact.text(continued, values)).toBe(continued)
  })

  test("redacts a named key inside a JSON-escaped string", () => {
    const key = "test0123456789abcdef0123456789abc"
    expect(MemoryRedact.text(`"input": "API_KEY=\\"${key}\\""`, values)).toBe(`"input": "API_KEY=\\"[redacted]\\""`)
    expect(MemoryRedact.text(`\\"api_key\\":\\"${key}\\"`, values)).toBe(`\\"api_key\\":\\"[redacted]\\"`)
    expect(MemoryRedact.text(`\\"api_key\\":${key}\\"`, values)).toBe(`\\"api_key\\":[redacted]\\"`)
    expect(MemoryRedact.blocksWrite(`\\"api_key\\":\\"${key}\\"`, `\\"api_key\\":\\"[redacted]\\"`)).toBe(true)
    expect(MemoryRedact.text(`API_KEY=\\"abc123\\"`, values)).toBe(`API_KEY=\\"abc123\\"`)
    expect(MemoryRedact.text(`token_type=\\"${key}\\"`, values)).toBe(`token_type=\\"${key}\\"`)
  })

  test("redacts corpus strings to their declared expectations", async () => {
    const file = Bun.file(new URL("./fixtures/redaction/text-cases.json", import.meta.url))
    const raw = await file.text()
    const cleaned = JSON.parse(MemoryRedact.text(raw, values)) as {
      cases: Array<{ id: string; input: string; expected: string }>
    }
    const original = (await file.json()) as { cases: Array<{ id: string; input: string; expected: string }> }
    // These shapes need a second decode layer or a shell parser; the dedicated tests cover them.
    // Any new row with one of these shapes must be added here deliberately.
    const skip = new Set([
      "credential-newline",
      "credential-crlf",
      "private-key-block",
      "prefix-after-newline",
      "named-yaml-block",
      "named-triple-quotes",
      "named-command-substitution",
      "miss-yaml-empty-block",
      "boundary-escaped-inner-quote",
      "boundary-cli-json-tail",
      "boundary-command-quoted",
      "named-escaped-inner-short",
      "named-triple-short",
      "miss-certificate-block",
      "named-json-short",
    ])
    const skipped: string[] = []
    original.cases.forEach((item, index) => {
      if (skip.has(item.id)) {
        skipped.push(item.id)
        return
      }
      expect(cleaned.cases[index]?.input, item.id).toBe(item.expected)
      expect(cleaned.cases[index]?.expected, item.id).toBe(item.expected)
    })
    expect(skipped.sort()).toEqual([...skip].sort())
  })

  test("preserves surrounding delimiters and suffixes", () => {
    const key = "test0123456789abcdef0123456789abc"
    const cases = [
      [`{"input":"password=\\"prefix\\"${key}\\""}`, `{"input":"password=\\"[redacted]\\""}`],
      [`{"cmd":"tool --password Secret123\\"x","keep":1}`, `{"cmd":"tool --password [redacted]\\"x","keep":1}`],
      ["mysql -pSecret123] next", "mysql -p[redacted]] next"],
      ["user@example.com:Secret123&next=1", "user@example.com:[redacted]&next=1"],
      ['password=$(printf "x)"; echo Secret123)', "password=[redacted]"],
      ['password=$(printf "x)"; echo Secret123) after', "password=[redacted] after"],
      ["tool --password Secret123 --next 1", "tool --password [redacted] --next 1"],
      ["SETX PASSWORD Secret123", "SETX PASSWORD [redacted]"],
      ["SeTx PaSsWoRd Secret123", "SeTx PaSsWoRd [redacted]"],
      ["cOOkie: session=CookieSecret123456; theme=dark", "cOOkie: session=[redacted]; theme=dark"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)
  })

  test("blocks writing a marker over every identifiable outbound value", () => {
    const blocked = [
      ["X-Api-Key: abcdefghijklmnop", "X-Api-Key: [redacted]"],
      ["tool --password Secret123", "tool --password [redacted]"],
      ["GOCSPX-demoA1b2C3d4E5f6G7h8", "[redacted]"],
      ["https://example.test/?sig=AzureSecret123456", "https://example.test/?sig=[redacted]"],
    ] as const
    for (const [old, next] of blocked) expect(MemoryRedact.blocksWrite(old, next), old).toBe(true)

    expect(MemoryRedact.blocksWrite("X-Api-Key: abcdefghijklmnop", "X-Api-Key: rotated1234567890")).toBe(false)
    expect(MemoryRedact.blocksWrite("X-Api-Key: abcdefghijklmnop", "")).toBe(false)
    expect(MemoryRedact.blocksWrite("X-Api-Key: [redacted]", "OTHER: [redacted]")).toBe(false)
    expect(MemoryRedact.blocksWrite("GOCSPX-demoA1b2C3d4E5f6G7h8", "OTHER: [redacted]")).toBe(false)
    expect(MemoryRedact.blocksWrite("oc_sk_" + "0123456789ab_" + "a".repeat(39), "[redacted]")).toBe(true)
    expect(MemoryRedact.blocksWrite("Authorization: Token " + "a".repeat(32), "Authorization: Token [redacted]")).toBe(
      true,
    )
    expect(MemoryRedact.blocksWrite("tool --api-key " + "a".repeat(20), "tool --api-key [redacted]")).toBe(true)
    expect(
      MemoryRedact.blocksWrite('KILO_AUTH_CONTENT={"azure":{"key":"abc123"}}', "KILO_AUTH_CONTENT=[redacted]"),
    ).toBe(true)
    expect(
      MemoryRedact.blocksWrite("X-Api-Key: abcdefghijklmnop\nnext=1", "X-Api-Key: [redacted]\nnext=1"),
    ).toBe(true)
    expect(
      MemoryRedact.blocksWrite("Cookie: session=CookieSecret123456; theme=dark", "Cookie: session=[redacted]; theme=dark"),
    ).toBe(true)
    expect(
      MemoryRedact.blocksWrite("Cookie: session=CookieSecret123456; theme=dark", "Cookie: session=rotated123456789; theme=dark"),
    ).toBe(false)
  })

  test("stays roughly linear on command-heavy inputs", () => {
    const measure = (input: string) => {
      MemoryRedact.text(input, values)
      return [0, 1, 2]
        .map(() => {
          const start = performance.now()
          MemoryRedact.text(input, values)
          return performance.now() - start
        })
        .sort((a, b) => a - b)[0]
    }
    const families = [
      (size: number) => "mysql ".repeat(size),
      (size: number) => `${"machine ".repeat(size)}passwordX`,
      (size: number) => `${"a".repeat(size * 2)}@example.com`,
    ]
    for (const make of families) {
      const small = measure(make(2_000))
      const big = measure(make(8_000))
      // Linear work grows 4x; 10x leaves room for noise while still catching quadratic scans.
      expect(big).toBeLessThan(small * 10 + 20)
      expect(big).toBeLessThan(2_000)
    }
  })

  test("strong names accept letter-only values but keep placeholders and public keys", () => {
    const cases = [
      ["API_KEY=abcdefghijklmnop", "API_KEY=[redacted]"],
      ['API_KEY="ABCDEFGHIJKLMNOP"', 'API_KEY="[redacted]"'],
      ["CLIENT_SECRET=abcdefghijklmnop", "CLIENT_SECRET=[redacted]"],
      ["SECRET_KEY=abcdefghijklmnop", "SECRET_KEY=[redacted]"],
      ["SIGNING_KEY=abcdefghijklmnop", "SIGNING_KEY=[redacted]"],
      ["ENCRYPTION_KEY=abcdefghijklmnop", "ENCRYPTION_KEY=[redacted]"],
      ["AUTH_TOKEN=abcdefghijklmnop", "AUTH_TOKEN=[redacted]"],
      ["AWS_SECRET_ACCESS_KEY=abcdefghijklmnop", "AWS_SECRET_ACCESS_KEY=[redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      "API_KEY=abc123",
      "API_KEY=1234567890123456",
      "PUBLIC_KEY=abcdefghijklmnop",
      "CACHE_KEY=abcdefghijklmnop",
      "API_KEY=string",
      "API_KEY=${API_KEY}",
      "API_KEY=",
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)

    expect(MemoryRedact.blocksWrite("API_KEY=abcdefghijklmnop", "API_KEY=[redacted]")).toBe(true)
  })

  test("catches additional token families and context carriers", () => {
    const make = (prefix: string, body: string) => prefix + body
    const rep = (char: string, size: number) => char.repeat(size)
    const cases = [
      [make("oc_sk_", `0123456789ab_${rep("a", 39)}`), "[redacted]"],
      [make("A3T", rep("A", 17)), "[redacted]"],
      [make("ABIA", rep("A", 16)), "[redacted]"],
      [make("ACCA", rep("A", 16)), "[redacted]"],
      [make("ABSK", rep("A", 100)), "[redacted]"],
      [make("doo_v1_", rep("a", 64)), "[redacted]"],
      [make("dor_v1_", rep("a", 64)), "[redacted]"],
      [make("dp.pt.", rep("a", 32)), "[redacted]"],
      [make("dapi", rep("a", 32)), "[redacted]"],
      [make("sk_test_", rep("a", 20)), "[redacted]"],
      [make("sk_prod_", rep("a", 20)), "[redacted]"],
      [make("rk_test_", rep("a", 20)), "[redacted]"],
      [make("rk_prod_", rep("a", 20)), "[redacted]"],
      [make("glpat-", `${rep("a", 20)}.ab.${rep("c", 9)}`), "[redacted]"],
      [make("whsec_", rep("a", 32)), "[redacted]"],
      [make("sb_secret_", `${rep("a", 20)}_${rep("b", 20)}`), "[redacted]"],
      [make("ntn_", rep("a", 40)), "[redacted]"],
      [make("sntryu_", rep("a", 40)), "[redacted]"],
      [make("sntrys_", rep("a", 40)), "[redacted]"],
      [make("vck_", rep("a", 20)), "[redacted]"],
      [make("cfoat_", rep("a", 30)), "[redacted]"],
      [make("rpa_", rep("a", 20)), "[redacted]"],
      [make("fw_", rep("a", 20)), "[redacted]"],
      [make("api_org_", rep("a", 34)), "[redacted]"],
      [`https://hooks.slack.com/services/T000/B000/XXXX`, "[redacted]"],
      [`${rep("a", 20)}.atlasv1.${rep("b", 20)}-tail`, "[redacted]"],
      [`KILO_AUTH_CONTENT={"azure":{"key":"abc123"}}`, "KILO_AUTH_CONTENT=[redacted]"],
      [`SUPABASE_SERVICE_ROLE_KEY=${rep("a", 32)}`, "SUPABASE_SERVICE_ROLE_KEY=[redacted]"],
      [`Authorization: Token ${rep("a", 32)}`, "Authorization: Token [redacted]"],
      [`tool --api-key ${rep("a", 20)}`, "tool --api-key [redacted]"],
      [`tool --auth-token ${rep("a", 20)}`, "tool --auth-token [redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      make("oc_sk_", `${rep("A", 12)}_${rep("a", 39)}`),
      make("oc_sk_", `0123456789ab_${rep("a", 19)}`),
      `document_${make("oc_sk_", `0123456789ab_${rep("a", 39)}`)}`,
      make("A3T", rep("A", 15)),
      make("sk_test_", rep("a", 8)),
      make("whsec_", rep("a", 8)),
      make("sntrys_", rep("a", 8)),
      make("api_org_", rep("a", 8)),
      `KILO_CONFIG_CONTENT={"experimental":{}}`,
      "SUPABASE_SERVICE_ROLE=public",
      "Authorization: Token short",
      "Token is required",
      "tool --api-key",
      "https://hooks.slack.com/",
    ] as const
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
  })

  test("reads CLI flags and credential files", () => {
    const cases = [
      ["tool --password Secret123", "tool --password [redacted]"],
      ["mysql -pSecret123", "mysql -p[redacted]"],
      ["curl -u alice:CurlSecret123456 https://example.test", "curl -u alice:[redacted] https://example.test"],
      ["db.test:5432:app:alice:PgPassSecret123", "db.test:5432:app:alice:[redacted]"],
      ["machine db.test login alice password NetrcSecret123", "machine db.test login alice password [redacted]"],
      ["setx PASSWORD WinSecret123", "setx PASSWORD [redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      "tool --password",
      "mysql -p",
      "curl -u alice",
      "setx PATH /usr/bin",
      "db:5432:app:alice:Secret123",
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
  })

  test("masks YAML blocks, triple quotes and command substitutions", () => {
    const nl = String.fromCharCode(10)
    expect(MemoryRedact.text(`password: |${nl}  Secret123`, values)).toBe("password: [redacted]")
    expect(MemoryRedact.text('password = """Secret123"""', values)).toBe("password = [redacted]")
    expect(MemoryRedact.text(`password=$(cat <<EOF${nl}Secret123${nl}EOF)`, values)).toBe("password=[redacted]")
    expect(MemoryRedact.text(`password: |${nl}next = 1`, values)).toBe(`password: |${nl}next = 1`)
  })

  test("catches additional provider prefixes", () => {
    const cases = [
      "GOCSPX-demoA1b2C3d4E5f6G7h8",
      "shpat_demoA1b2C3d4E5f6",
      "lin_api_demoLinearA1b2C3d4",
      "r8_demoReplicateA1b2C3d4",
      "pplx-demoPerplexityA1b2C3d4",
      "sq0csp-demoSecretA1b2C3d4",
      "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQ",
      "key-demoMailgunA1b2C3d4E5f6G7h8",
      "secret_demoNotionA1b2C3d4",
      "MTIzNDU2Nzg5MDEyMzQ1Njc4.A1b2C3.abcdefghijklmnopqrstuvwxyz1",
      "123456789:AA_demoToken1234567890abcdefgh",
    ]
    for (const item of cases) expect(MemoryRedact.text(item, values), item).toBe("[redacted]")
    for (const item of ["GOCSPX-short", "shpat_short", "key-value", "secret_name", "1.2.3"]) {
      expect(MemoryRedact.text(item, values), item).toBe(item)
    }
  })

  test("masks signed URLs, Cookie sessions and header API keys", () => {
    const cases = [
      [
        "https://example.test/blob?sv=2026&sig=AzureSecret123456",
        "https://example.test/blob?sv=2026&sig=[redacted]",
      ],
      [
        "https://s3.example.test/object?X-Amz-Signature=abcdef0123456789abcdef",
        "https://s3.example.test/object?X-Amz-Signature=[redacted]",
      ],
      [
        "Authorization: AWS4-HMAC-SHA256 Credential=AKIA1234567890ABCDEF/20261120/x, Signature=abcdef0123456789abcdef0123456789",
        "Authorization: AWS4-HMAC-SHA256 Credential=[redacted], Signature=[redacted]",
      ],
      ["Cookie: session=CookieSecret123456; theme=dark", "Cookie: session=[redacted]; theme=dark"],
      ["X-Api-Key: abcdefghijklmnop", "X-Api-Key: [redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)
    expect(MemoryRedact.text("https://x.test/?page=2&x=1", values)).toBe("https://x.test/?page=2&x=1")
    expect(MemoryRedact.text("https://example.test/?X-Amz-Credential=AKIA1234567890ABCDEF", values)).toBe(
      "https://example.test/?X-Amz-Credential=[redacted]",
    )
    expect(MemoryRedact.text("https://example.test/?X-Amz-Security-Token=Token1234567890", values)).toBe(
      "https://example.test/?X-Amz-Security-Token=[redacted]",
    )
    expect(MemoryRedact.text("X-Auth-Token: abcdefghijklmnop", values)).toBe("X-Auth-Token: [redacted]")
    expect(MemoryRedact.text("Cookie: sessionid=Session123456; connect.sid=Connect123456; auth=Auth123456", values)).toBe(
      "Cookie: sessionid=[redacted]; connect.sid=[redacted]; auth=[redacted]",
    )
  })

  test("fixes existing boundaries: query, brackets, PWD, status words and pairs", () => {
    expect(MemoryRedact.text("https://x.test/?access_token=abc1234567890123&x=1", values)).toBe(
      "https://x.test/?access_token=[redacted]&x=1",
    )
    expect(MemoryRedact.text("password[]=Secret123", values)).toBe("password[]=[redacted]")
    expect(MemoryRedact.text("password[0]=Secret123", values)).toBe("password[0]=[redacted]")
    expect(MemoryRedact.text("db.PWD=/home/user", values)).toBe("db.PWD=/home/user")
    for (const word of ["enabled", "required", "none", "default", "optional", "disabled", "include"]) {
      expect(MemoryRedact.text(`password: ${word}`, values), word).toBe(`password: ${word}`)
    }
    expect(MemoryRedact.text("passwords: include", values)).toBe("passwords: include")
    expect(MemoryRedact.text("git@github.com:123456", values)).toBe("git@github.com:123456")
    expect(MemoryRedact.text("user@example.com:2024-01-01", values)).toBe("user@example.com:[redacted]")
    expect(MemoryRedact.text("WWW-Authenticate: Bearer realm=example.com", values)).toBe(
      "WWW-Authenticate: Bearer realm=example.com",
    )
  })

  test("redacts explicit password values and skips references and type annotations", () => {
    const cases = [
      ["password=hunter2", "password=[redacted]"],
      ["DB_PASSWORD=Tr0ub4dor&3", "DB_PASSWORD=[redacted]"],
      ['password: "MyP@ssw0rd"', 'password: "[redacted]"'],
      ["passwd=123456", "passwd=[redacted]"],
      ["dbPassword=short", "dbPassword=[redacted]"],
      ['password="hunter2."', 'password="[redacted]"'],
      ['password="$ecret123"', 'password="[redacted]"'],
      ['password="false"', 'password="[redacted]"'],
      ["password=changeme", "password=[redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      "password=${DB_PASSWORD}",
      "password=<your-password>",
      "password=process.env.DB_PASSWORD",
      "password: string",
      "password: boolean",
      "password: false",
      "password=",
      "password=[redacted]",
      "password_hash=hunter2",
      "private_key=abc",
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)

    expect(MemoryRedact.blocksWrite("password=hunter2", "password=[redacted]")).toBe(true)
    expect(MemoryRedact.blocksWrite("password=hunter2", "password=changed")).toBe(false)
    expect(MemoryRedact.blocksWrite("password=changeme", "password=[redacted]")).toBe(true)
  })

  test("treats pwd as a password name but keeps the shell PWD variable", () => {
    expect(MemoryRedact.text("pwd=hunter2", values)).toBe("pwd=[redacted]")
    expect(MemoryRedact.text("DB_PWD=123456", values)).toBe("DB_PWD=[redacted]")
    expect(MemoryRedact.text("dbPwd=short", values)).toBe("dbPwd=[redacted]")
    expect(MemoryRedact.text("PWD=/home/user", values)).toBe("PWD=/home/user")
    expect(MemoryRedact.text("pwd=${PWD}", values)).toBe("pwd=${PWD}")
  })

  test("masks the password in an email-password pair and leaves scp URLs alone", () => {
    const cases = [
      ["test@example.com:123456", "test@example.com:[redacted]"],
      ["test@example.com:123123", "test@example.com:[redacted]"],
      ["user.name+tag@sub.example.co.uk:Hunter2!", "user.name+tag@sub.example.co.uk:[redacted]"],
      ["creds test@example.com:123456, next", "creds test@example.com:[redacted], next"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      "git@github.com:acme/repo.git",
      "user@example.com:8080",
      "support@example.com:welcome",
      "git@github.com:main",
      "contact@example.com:12345",
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)

    expect(MemoryRedact.blocksWrite("test@example.com:123456", "test@example.com:[redacted]")).toBe(true)
    expect(MemoryRedact.blocksWrite("test@example.com:123456", "test@example.com:654321")).toBe(false)
  })

  test("recognizes qualified key aliases and connection-string fields", () => {
    const key = "7c1e9a4d2f8b6a0e3d5c7f9b1a4e6d8c"
    const b64 = "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A="
    const cases = [
      [`AZURE_OPENAI_KEY=${key}`, "AZURE_OPENAI_KEY=[redacted]"],
      [`AZURE_STORAGE_ACCOUNT_KEY=${key}`, "AZURE_STORAGE_ACCOUNT_KEY=[redacted]"],
      [`storageAccountKey=${key}`, "storageAccountKey=[redacted]"],
      [`DD_APP_KEY=${key}`, "DD_APP_KEY=[redacted]"],
      [`LICENSE_KEY=${key}`, "LICENSE_KEY=[redacted]"],
      [
        `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${b64};EndpointSuffix=core.windows.net`,
        "AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=[redacted];EndpointSuffix=core.windows.net",
      ],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      `DD_APP_KEY_ENV=${key}`,
      `LOCAL_STORAGE_KEY=${key}`,
      `PUBLIC_KEY=${key}`,
      `cache_key=${key}`,
      `ssh_key=${key}`,
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
  })

  test("keeps credential and credentials on the key shape", () => {
    const clean = ['credentials="user:pass"', 'credentials: "required"', 'credentials: "include"', "credential=pass123"]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
    expect(MemoryRedact.text('credential="Abcdefghijklmn1234"', values)).toBe('credential="[redacted]"')
  })

  test("recognizes credential, auth, password and private key names", () => {
    const secret = "Abcdefghijklmn1234"
    const cases = [
      [`credential=${secret}`, "credential=[redacted]"],
      [`credentials = "${secret}"`, 'credentials = "[redacted]"'],
      [`auth=${secret}`, "auth=[redacted]"],
      [`password: ${secret}`, "password: [redacted]"],
      [`private_key=${secret}`, "private_key=[redacted]"],
      [`privateKey = "${secret}"`, 'privateKey = "[redacted]"'],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = [
      `oauth_client=${secret}`,
      `auth_mode=${secret}`,
      `password_hash=${secret}`,
      `credential_id=${secret}`,
      `private_key_file=${secret}`,
    ]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
  })

  test("redacts dotted provider tokens and the added standalone prefixes", () => {
    const cases = [
      ["SG.a1B2c3D4e5F6g7H8i9J0k1.m3N4p5Q6r7S8t9U0v1W2x3Y4z5", "[redacted]"],
      ["hvs.A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6", "[redacted]"],
      ["A7b8C9d0E1f2G3h4.atlasv1.J5k6L7m8N9p0Q1r2S3t4U5v6", "[redacted]"],
      ['SENDGRID_API_KEY="SG.a1B2c3D4e5F6g7H8i9J0k1.m3N4p5Q6r7S8t9U0v1W2x3Y4z5"', 'SENDGRID_API_KEY="[redacted]"'],
      ["VAULT_TOKEN=hvs.A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6", "VAULT_TOKEN=[redacted]"],
      [
        "TF_TOKEN_app_terraform_io=A7b8C9d0E1f2G3h4.atlasv1.J5k6L7m8N9p0Q1r2S3t4U5v6",
        "TF_TOKEN_app_terraform_io=[redacted]",
      ],
      ["ASIAH4K8P2D6M9R3T7W5", "[redacted]"],
      ["glpat-a1B2c3D4e5F6g7H8i9J0", "[redacted]"],
      ["npm_a1B2c3D4e5F6g7H8i9J0k1L2m3N4p5Q6r7S8", "[redacted]"],
      ["pypi-AgEIcHlwaS5vcmc7aBcD9eFgH1jKlM3nOpQ5rStU7vWxY9zA", "[redacted]"],
      ["dop_v1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2", "[redacted]"],
      ["cfut_a1B2c3D4e5F6g7H8i9J0k1L2m3N4p5Q6r7S8t9U0", "[redacted]"],
      ["NRAK-a1b2c3d4e5f6a7b8c9d0e1f2", "[redacted]"],
    ] as const
    for (const [input, expected] of cases) expect(MemoryRedact.text(input, values), input).toBe(expected)

    const clean = ["npm_package_scripts_test=value", "pypi-short", "SG.short", "A7b8.atlasv1.short"]
    for (const item of clean) expect(MemoryRedact.text(item, values), item).toBe(item)
  })

  test("leaves ordinary code, passwords, plain URLs, cards and templates alone", () => {
    const clean = [
      "token: string",
      "token?: string",
      "apiKey: ApiKey",
      "login(token: string)",
      "if (token === x) {}",
      "token == null",
      "const secret = process.env.SECRET",
      "headers.authorization = build(token)",
      "api_key: config.key",
      "max_tokens: 4096",
      "Bearer ${token}",
      "sk-learn",
      "const course = 'sk-learn-more'",
      "password=${DB_PASSWORD}",
      "https://example.test/path",
      "git clone ssh://git@github.com/acme/repo.git",
      "git@github.com:acme/repo.git",
      "4111 1111 1111 1111",
      'token = "${token}"',
      "secret: enabled",
      "author: Jane",
      "tokenize(x)",
      'type Token = "access" | "refresh"',
      'token_type: "Bearer"',
      'secret_name = "prod-db"',
      '{"max_tokens": "4096"}',
      '"provider.apiKey": "API key"',
      '{ token: "abc" }',
      'token_type: "abcdef1234567890xyz"',
      'secret_name = "abcdef1234567890xyz"',
      'api_key_env = "abcdef1234567890xyz"',
      'githubtoken = "abcdef1234567890xyz"',
      'token = "abcdef1234567890${token}"',
    ]
    for (const item of clean) {
      expect(MemoryRedact.has(item, values), item).toBe(false)
      expect(MemoryRedact.text(item, values), item).toBe(item)
    }
  })

  test("does not treat Hugging Face identifiers as keys", () => {
    for (const input of ["hf_hub_download_with_retries(repo)", "hf_abcdefghijklmnopqrstuvwxyz_012345"]) {
      expect(MemoryRedact.text(input, values)).toBe(input)
    }
  })

  test("is idempotent and does not treat a marker-only value as a key", () => {
    const key = 'API_KEY = "abcdef1234567890xyz"'
    const once = MemoryRedact.text(key, values)
    expect(once).toBe(`API_KEY = "${marker}"`)
    expect(MemoryRedact.has(once, values)).toBe(false)
    expect(MemoryRedact.text(once, values)).toBe(once)

    const only = `API_KEY = "${marker}"`
    expect(MemoryRedact.has(only, values)).toBe(false)
    expect(MemoryRedact.text(only, values)).toBe(only)

    // A marker as part of a real value does not make the value safe.
    expect(MemoryRedact.has(`API_KEY = "${marker}suffix123"`, values)).toBe(true)
    expect(MemoryRedact.text(`API_KEY = "${marker}suffix123"`, values)).toBe(`API_KEY = "${marker}"`)
    expect(MemoryRedact.text(`API_KEY = "prefix123${marker}"`, values)).toBe(`API_KEY = "${marker}"`)
  })

  test("value() redacts only recognized key strings under sensitive names", () => {
    expect(MemoryRedact.value({ api_key: "sk-abcdefghijklmnopqrstuvwxyz012345" }, undefined, values)).toEqual({
      api_key: "[redacted]",
    })
    expect(MemoryRedact.value({ token: "abcdef1234567890xyz" }, undefined, values)).toEqual({ token: "[redacted]" })
    expect(MemoryRedact.value({ token: "short" }, undefined, values)).toEqual({ token: "short" })
    expect(MemoryRedact.value({ token: 4096 }, undefined, values)).toEqual({ token: 4096 })
    expect(MemoryRedact.value({ token: true }, undefined, values)).toEqual({ token: true })
    expect(MemoryRedact.value({ token: null }, undefined, values)).toEqual({ token: null })
    expect(MemoryRedact.value({ note: 'API_KEY = "abcdef1234567890xyz"' }, undefined, values)).toEqual({
      note: 'API_KEY = "[redacted]"',
    })
    // A structured credential keeps its name and scheme; only the credential is scrubbed.
    expect(MemoryRedact.value({ Authorization: "Bearer abcdef1234567890xyz" }, undefined, values)).toEqual({
      Authorization: "Bearer [redacted]",
    })
    expect(MemoryRedact.value({ Authorization: "Basic dXNlcjpwYXNzd29yZA==" }, undefined, values)).toEqual({
      Authorization: "Basic [redacted]",
    })
    // The legacy contract is unchanged without opts.
    expect(MemoryRedact.value({ token: 4096 })).toEqual({ token: "[redacted]" })
  })

  test("value() applies a sensitive name to array elements and weak secrets", () => {
    // An array element inherits the enclosing property name; the scalar form is already caught.
    expect(MemoryRedact.value({ token: ["abcdef1234567890xyz"] }, undefined, values)).toEqual({
      token: ["[redacted]"],
    })
    expect(MemoryRedact.value({ token: [["abcdef1234567890xyz"]] }, undefined, values)).toEqual({
      token: [["[redacted]"]],
    })
    // Weak names redact any explicit value, scalar or array-wrapped.
    expect(MemoryRedact.value({ password: "hunter2" }, undefined, values)).toEqual({ password: "[redacted]" })
    expect(MemoryRedact.value({ password: ["hunter2", "Tr0ub4dor&3"] }, undefined, values)).toEqual({
      password: ["[redacted]", "[redacted]"],
    })
    // References and templates under a weak name stay readable; a literal default is a secret.
    const readable = ["${DB_PASSWORD}", "process.env.DB_PASSWORD", "<your-password>"]
    expect(MemoryRedact.value({ password: readable }, undefined, values)).toEqual({ password: readable })
    expect(MemoryRedact.value({ password: ["changeme"] }, undefined, values)).toEqual({ password: ["[redacted]"] })
    // An authorization array keeps the scheme and scrubs only the credential.
    expect(MemoryRedact.value({ Authorization: ["Bearer abcdef1234567890xyz"] }, undefined, values)).toEqual({
      Authorization: ["Bearer [redacted]"],
    })
    // Non-sensitive arrays and short values are left alone.
    expect(MemoryRedact.value({ notes: ["abcdef1234567890xyz"] }, undefined, values)).toEqual({
      notes: ["abcdef1234567890xyz"],
    })
    expect(MemoryRedact.value({ token: ["short"] }, undefined, values)).toEqual({ token: ["short"] })
  })

  test("stays linear on large inputs", () => {
    const solid = "a1._-".repeat(200_000)
    const code = "const token = process.env.TOKEN\nif (apiKey === null) login(token)\n".repeat(20_000)
    for (const [name, item] of [
      ["solid", solid],
      ["code", code],
    ] as const) {
      // The first full pass compiles the scan loop; the budget covers steady-state cost, not JIT tiers.
      expect(MemoryRedact.text(item, values)).toBe(item)
      const runs = [0, 1, 2].map(() => {
        const start = performance.now()
        expect(MemoryRedact.text(item, values)).toBe(item)
        return performance.now() - start
      })
      // The minimum ignores a single GC pause; a real slowdown moves every run.
      expect(Math.min(...runs), name).toBeLessThan(100)
    }
  })

  test("checks Basic candidates in a 1 MiB line within the values-mode budget", () => {
    for (const word of ["basic x ", "basic abcd1234 "]) {
      const input = word.repeat(Math.ceil(1024 ** 2 / word.length)).slice(0, 1024 ** 2)
      // The first full pass compiles the scan loop; the budget covers steady-state cost, not JIT tiers.
      expect(MemoryRedact.text(input, values)).toBe(input)
      const runs = [0, 1, 2].map(() => {
        const start = performance.now()
        expect(MemoryRedact.text(input, values)).toBe(input)
        return performance.now() - start
      })
      // The minimum ignores a single GC pause; a real slowdown moves every run.
      expect(Math.min(...runs)).toBeLessThan(100)
    }
  })

  test("Failure is an Error without the value and names the way out", () => {
    const failure = new MemoryRedact.Failure()
    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe("MemoryRedactFailure")
    expect(failure.cause).toBeUndefined()
    expect(failure.message).toContain("secret")
    expect(failure.message).toContain("Roll back")
    expect(failure.message).toContain("Redact recognizable secrets before sending")
    expect(failure.message).toContain("Experimental")
    expect(failure.message).not.toMatch(/try again|timeout|network|unsupported|overloaded/i)
  })
})

describe("memory redact file write guard", () => {
  const key = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"
  const marker = "[redacted]"

  test("blocks replacing a named key with the marker", () => {
    expect(MemoryRedact.blocksWrite('API_KEY = "abcdef1234567890xyz"', 'API_KEY = "[redacted]"')).toBe(true)
    expect(MemoryRedact.blocksWrite(`API_KEY="prefix123${marker}suffix"`, `API_KEY="${marker}"`)).toBe(true)
    expect(MemoryRedact.blocksWrite("API_KEY=abcdef1234567890xyz", "API_KEY=[redacted]")).toBe(true)
  })

  test("blocks replacing a standalone prefixed key with the marker", () => {
    expect(MemoryRedact.blocksWrite(`const key = "${key}"`, `const key = "${marker}"`)).toBe(true)
    expect(MemoryRedact.blocksWrite(`Authorization: Bearer ${key}`, `Authorization: Bearer ${marker}`)).toBe(true)
  })

  test("does not count a named assignment value as a standalone key", () => {
    // Exact marker replacement is still blocked through the named comparison.
    expect(MemoryRedact.blocksWrite(`API_KEY=${key}`, `API_KEY=${marker}`)).toBe(true)
    expect(MemoryRedact.blocksWrite(`API_KEY="${key}"`, `API_KEY="${marker}"`)).toBe(true)
    // A marker with a suffix leaves a key-shaped value, so the named rule allows the edit and the
    // prefixed key inside the assignment value must not block it on its own.
    expect(MemoryRedact.blocksWrite(`API_KEY=${key}`, `API_KEY=${marker}suffix`)).toBe(false)
    expect(MemoryRedact.blocksWrite(`API_KEY="${key}"`, `API_KEY="${marker}suffix"`)).toBe(false)
    // A prefixed key that is not a named assignment value still blocks when replaced.
    expect(MemoryRedact.blocksWrite(`payload = "${key}"`, `payload = "${marker}"`)).toBe(true)
  })

  test("does not block masking values that the named rule leaves unchanged", () => {
    expect(MemoryRedact.blocksWrite('MISTRAL_API_KEY="abc123"', `MISTRAL_API_KEY="${marker}"`)).toBe(false)
    expect(MemoryRedact.blocksWrite('config.api_key = "abc123"', `config.api_key = "${marker}"`)).toBe(false)
    expect(MemoryRedact.blocksWrite('{ "api_key": "abc123" }', `{ "api_key": "${marker}" }`)).toBe(false)
    expect(MemoryRedact.blocksWrite('token_type="abcdef1234567890xyz"', `token_type="${marker}"`)).toBe(false)
    // An exact marker is not a key, and an interpolated template is not redacted in the first place.
    expect(MemoryRedact.blocksWrite(`MISTRAL_API_KEY="${marker}"`, `MISTRAL_API_KEY="${marker}"`)).toBe(false)
    expect(MemoryRedact.blocksWrite('MISTRAL_API_KEY="${value}"', `MISTRAL_API_KEY="${marker}"`)).toBe(false)
    // A short bare value is neither redacted by text() nor counted as a key.
    expect(MemoryRedact.text("API_KEY=abc123", { values: true })).toBe("API_KEY=abc123")
    expect(MemoryRedact.blocksWrite("API_KEY=abc123", `API_KEY=${marker}`)).toBe(false)
  })

  test("allows new files, key deletion and edits that keep every key", () => {
    // A new file has nothing to lose.
    expect(MemoryRedact.blocksWrite("", `API_KEY="${key}"`)).toBe(false)
    // Deleting the key line without adding a marker is a normal edit.
    expect(MemoryRedact.blocksWrite(`A=1\nAPI_KEY="${key}"\nB=2`, "A=1\nB=2")).toBe(false)
    // An unrelated marker elsewhere does not block deleting a key.
    expect(MemoryRedact.blocksWrite(`NOTE="${marker}"\nAPI_KEY="${key}"`, `NOTE="${marker}"`)).toBe(false)
    // Adding marker expectations while the key stays in place passes.
    expect(MemoryRedact.blocksWrite(`API_KEY="${key}"`, `API_KEY="${key}"\nEXPECTED = "${marker}"`)).toBe(false)
    // No keys at all.
    expect(MemoryRedact.blocksWrite("const x = 1", "const x = 2")).toBe(false)
    // A value already equal to the marker is not a key.
    expect(MemoryRedact.blocksWrite(`API_KEY="${marker}"`, `API_KEY="${marker}"`)).toBe(false)
  })
})
