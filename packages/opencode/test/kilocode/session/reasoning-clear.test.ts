import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as Clear from "@/kilocode/session/reasoning-clear"
import * as Marker from "@/kilocode/session/reasoning-marker"
import { ReasoningClearPayload, ReasoningClearPreviewPayload } from "@/kilocode/server/httpapi/groups/session"

const sessionID = SessionID.make("ses_reasoning_clear")

test("requires integer ranges in reasoning-clear schemas", () => {
  const decodePreview = Schema.decodeUnknownSync(ReasoningClearPreviewPayload)
  const decodeApply = Schema.decodeUnknownSync(ReasoningClearPayload)
  const decodePreviewResult = Schema.decodeUnknownSync(Clear.PreviewResult)
  const decodeApplyResult = Schema.decodeUnknownSync(Clear.ApplyResult)
  const preview = { turns: 0, parts: 0, tokens: 0, unsupported: 0, token: "token" }
  const apply = { parts: 0, turns: 0, tokens: 0 }

  expect(decodePreview({ keepTurns: 1 })).toEqual({ keepTurns: 1 })
  expect(decodePreview({ keepTurns: 100 })).toEqual({ keepTurns: 100 })
  expect(() => decodePreview({ keepTurns: 1.5 })).toThrow()
  expect(() => decodePreview({ keepTurns: 0 })).toThrow()
  expect(() => decodePreview({ keepTurns: 101 })).toThrow()
  expect(() => decodeApply({ keepTurns: 1.5, token: "token" })).toThrow()
  expect(decodeApply({ keepTurns: 1, token: "t" })).toEqual({ keepTurns: 1, token: "t" })
  expect(decodeApply({ keepTurns: 100, token: "t" })).toEqual({ keepTurns: 100, token: "t" })
  expect(() => decodeApply({ keepTurns: 0, token: "t" })).toThrow()
  expect(() => decodeApply({ keepTurns: 101, token: "t" })).toThrow()
  expect(() => decodeApply({ keepTurns: 10 })).toThrow()
  expect(() => decodeApply({ keepTurns: 10, token: null })).toThrow()
  expect(() => decodeApply({ keepTurns: 10, token: 5 })).toThrow()

  expect(decodePreviewResult(preview)).toEqual(preview)
  expect(() => decodePreviewResult({ ...preview, turns: 1.5 })).toThrow()
  expect(() => decodePreviewResult({ ...preview, parts: -1 })).toThrow()
  expect(decodeApplyResult(apply)).toEqual(apply)
  expect(() => decodeApplyResult({ ...apply, tokens: 1.5 })).toThrow()
  expect(() => decodeApplyResult({ ...apply, parts: -1 })).toThrow()
})

function user(id: string): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Number(id) },
      agent: "code",
      model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
    },
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        sessionID,
        messageID,
        type: "text",
        text: `turn ${id}`,
      },
    ],
  }
}

function assistant(id: string, parentID: MessageID, text: string): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Number(id) },
      parentID,
      mode: "code",
      agent: "code",
      modelID: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 1, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        sessionID,
        messageID,
        type: "reasoning",
        text,
        time: { start: 1, end: 2 },
      },
    ],
  }
}

function reasoning(
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
  end?: number,
): SessionV1.ReasoningPart {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID,
    type: "reasoning",
    text,
    metadata,
    time: { start: 1, ...(end === undefined ? {} : { end }) },
  }
}

function assistantWithParts(
  id: string,
  parentID: MessageID,
  parts: SessionV1.Part[],
  summary = false,
): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Number(id) || 1 },
      parentID,
      mode: "code",
      agent: "code",
      modelID: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 1, cache: { read: 0, write: 0 } },
      finish: "stop",
      ...(summary ? { summary: true } : {}),
    },
    parts,
  }
}

function sessions(messages: SessionV1.WithParts[]) {
  const stored = new Map(messages.flatMap((message) => message.parts).map((part) => [part.id, part]))
  const updates: SessionV1.Part[] = []
  return {
    updates,
    stored,
    service: {
      messages: () => Effect.succeed(messages),
      getPart: ({ partID }: { partID: PartID }) => Effect.succeed(stored.get(partID)),
      updatePart: (part: SessionV1.Part) => {
        updates.push(part)
        stored.set(part.id, part)
        for (const message of messages) {
          const index = message.parts.findIndex((item) => item.id === part.id)
          if (index >= 0) message.parts[index] = part
        }
        return Effect.succeed(part)
      },
    } as unknown as import("@/session/session").Session.Interface,
  }
}

test("sets the clear marker without mutating the reasoning part", () => {
  const part = reasoning(
    "marker-merge",
    "keep provider data",
    {
      [Marker.key]: { source: "legacy", cleared: 1 },
      provider: { value: true },
    },
    2,
  )
  const before = structuredClone(part)

  const marked = Marker.mark(part, 9)

  expect(marked.metadata).toEqual({
    [Marker.key]: { cleared: 9 },
    provider: { value: true },
  })
  expect(part).toEqual(before)
})

test("treats a numeric clear timestamp as cleared despite extra marker fields", () => {
  const part = reasoning("malformed-marker-fields", "already clear", {
    [Marker.key]: { cleared: 4, total: "invalid" },
  })

  expect(Marker.cleared(part)).toBe(true)
  expect(Marker.unsupported(part)).toBe(false)
})

test("rejects non-finite and non-numeric clear timestamps", () => {
  for (const [id, cleared] of [
    ["nan", NaN],
    ["infinity", Infinity],
    ["string", "4"],
  ] as const) {
    const part = reasoning(id, "marked", { [Marker.key]: { cleared } })
    expect(Marker.cleared(part)).toBe(false)
  }

  expect(Marker.cleared(user("marker-text").parts[0]!)).toBe(false)
})

test("clears only completed reasoning in represented turns outside keepTurns", async () => {
  const first = user("1")
  const second = user("2")
  const third = user("3")
  const messages = [
    first,
    assistant("11", first.info.id, "old thought"),
    second,
    assistant("22", second.info.id, "middle thought"),
    third,
    assistant("33", third.info.id, "current thought"),
  ]
  const stored = sessions(messages)

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(preview).toMatchObject({ turns: 2, parts: 2 })

  const result = await Effect.runPromise(
    Clear.apply({
      sessionID,
      keepTurns: 1,
      token: preview.token,
      sessions: stored.service,
    }),
  )
  expect(result).toMatchObject({ parts: 2, turns: 2 })
  expect(stored.updates.map((part) => String(part.id))).toEqual(["prt_11", "prt_22"])
  expect((stored.stored.get(PartID.make("prt_11")) as SessionV1.ReasoningPart).metadata).toEqual({
    "kilocode.reasoning": { cleared: expect.any(Number) },
  })
})

test("does not target summary, empty, incomplete, or already cleared reasoning", async () => {
  const first = user("10")
  const compact = user("20")
  compact.parts = [
    {
      id: PartID.make("prt_compaction"),
      sessionID,
      messageID: compact.info.id,
      type: "compaction",
      auto: false,
      tail_start_id: first.info.id,
    },
  ]
  const second = user("30")
  const marked = Marker.mark(reasoning("marked", "already clear", undefined, 2), 4)
  marked.messageID = MessageID.make("msg_20")
  const summaryPart = reasoning("summary", "summary text", undefined, 2)
  summaryPart.messageID = MessageID.make("msg_summary")
  const messages = [
    first,
    assistantWithParts("11", first.info.id, [
      reasoning("old", "old text", undefined, 2),
      reasoning("empty", "  ", { provider: { value: true } }, 2),
      reasoning("incomplete", "still thinking"),
      marked,
    ]),
    compact,
    assistantWithParts("summary", compact.info.id, [summaryPart], true),
    second,
    assistant("33", second.info.id, "current text"),
  ]
  const stored = sessions(messages)
  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ parts: 1, unsupported: 1 })
  expect(result.tokens).toBeGreaterThan(0)
})

test("skips unsupported carriers and finds nothing left after a successful apply", async () => {
  const old = user("40")
  const current = user("50")
  const unsupportedPart = reasoning("unsupported", "signed", { anthropic: { signature: "opaque" } }, 2)
  unsupportedPart.messageID = MessageID.make("msg_40")
  const messages = [
    old,
    assistantWithParts("41", old.info.id, [unsupportedPart]),
    current,
    assistant("51", current.info.id, "current"),
  ]
  const stored = sessions(messages)
  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(preview.unsupported).toBe(1)
  const skipped = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )
  expect(skipped).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(0)

  const plain = reasoning("plain", "clear me", undefined, 2)
  plain.messageID = MessageID.make("msg_40")
  messages[1]!.parts = [plain]
  stored.stored.set(plain.id, plain)
  const next = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  await Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: next.token, sessions: stored.service }))
  const again = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(again.parts).toBe(0)
})

test("clears supported reasoning, skips unsupported carriers, and rejects a repeated apply as stale", async () => {
  const old = user("400")
  const supported = reasoning("mixed-supported", "clear me", undefined, 2)
  supported.messageID = MessageID.make("msg_400")
  const unsupportedPart = reasoning("mixed-unsupported", "signed", { anthropic: { signature: "opaque" } }, 2)
  unsupportedPart.messageID = MessageID.make("msg_400")
  const reply = assistantWithParts("401", old.info.id, [supported, unsupportedPart])
  const current = user("410")
  const currentReply = assistant("411", current.info.id, "current")
  const stored = sessions([old, reply, current, currentReply])
  const before = structuredClone(unsupportedPart)

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(preview).toMatchObject({ parts: 1, unsupported: 1 })

  const result = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )
  expect(result).toMatchObject({ parts: 1, turns: 1 })
  expect(stored.updates.map((part) => String(part.id))).toEqual([String(supported.id)])
  expect(stored.stored.get(unsupportedPart.id)).toEqual(before)

  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service })),
  ).rejects.toThrow("stale")
  expect(stored.updates).toHaveLength(1)

  const after = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(after).toMatchObject({ parts: 0, unsupported: 1 })
})

test("does not assign an assistant with an unresolved parent to the latest turn", async () => {
  const old = user("60")
  const orphan = assistantWithParts("61", MessageID.make("msg_missing-parent"), [
    reasoning("orphan", "do not clear", undefined, 2),
  ])
  const current = user("70")
  const currentReply = assistant("71", current.info.id, "current")
  const stored = sessions([old, orphan, current, currentReply])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(preview.parts).toBe(0)
  expect(preview.turns).toBe(0)
})

test("does not assign an orphan assistant to the latest turn when keeping zero turns", async () => {
  const old = user("65")
  const orphan = assistantWithParts("66", MessageID.make("msg_missing-parent-zero"), [
    reasoning("orphan-zero", "do not clear", undefined, 2),
  ])
  const current = user("67")
  const currentReply = assistantWithParts("68", current.info.id, [])
  const stored = sessions([old, orphan, current, currentReply])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 0, sessions: stored.service }))

  expect(preview).toMatchObject({ parts: 0, turns: 0 })
})

test("propagates a part write failure", async () => {
  const old = user("100")
  const first = assistantWithParts("101", old.info.id, [reasoning("first-write", "first", undefined, 2)])
  const second = assistantWithParts("102", old.info.id, [reasoning("second-write", "second", undefined, 2)])
  const current = user("110")
  const currentReply = assistant("111", current.info.id, "current")
  const stored = sessions([old, first, second, current, currentReply])
  const fail = PartID.make("prt_second-write")
  const update = stored.service.updatePart
  const service = {
    ...stored.service,
    updatePart: ((part: SessionV1.Part) => {
      if (part.id === fail) return Effect.fail(new Error("write failed"))
      return update(part)
    }) as typeof stored.service.updatePart,
  } as typeof stored.service

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: service }))
  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: service })),
  ).rejects.toThrow("write failed")
  expect(stored.updates.map((part) => String(part.id))).toEqual(["prt_first-write"])
})

test("counts plain-text compaction parents as real turns and preserves summary reasoning", async () => {
  const old = user("120")
  const oldReply = assistant("121", old.info.id, "old")
  const parent = user("130")
  const summaryPart = reasoning("plain-summary", "summary reasoning", undefined, 2)
  summaryPart.messageID = MessageID.make("msg_plain-summary")
  const summary = assistantWithParts("plain-summary", parent.info.id, [summaryPart], true)
  const current = user("140")
  const currentReply = assistant("141", current.info.id, "current")
  const stored = sessions([old, oldReply, parent, summary, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ turns: 0, parts: 0 })
})

test("does not count compaction-only user messages as real turns", async () => {
  const first = user("310")
  const firstReply = assistant("311", first.info.id, "first old")
  const second = user("320")
  const secondReply = assistant("321", second.info.id, "second stays")
  const compact = user("330")
  compact.parts = [
    {
      id: PartID.make("prt_compaction-only"),
      sessionID,
      messageID: compact.info.id,
      type: "compaction",
      auto: false,
    },
  ]
  const third = user("340")
  const thirdReply = assistant("341", third.info.id, "current")
  const stored = sessions([first, firstReply, second, secondReply, compact, third, thirdReply])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 2, sessions: stored.service }))

  expect(preview).toMatchObject({ parts: 1, turns: 1 })
})

test("does not count synthetic continuation messages as user turns", async () => {
  const old = user("150")
  const oldReply = assistant("151", old.info.id, "old")
  const continuation = user("160")
  ;(continuation.parts[0] as SessionV1.TextPart).synthetic = true
  const continuationReply = assistant("161", continuation.info.id, "continuation")
  const current = user("170")
  const currentReply = assistant("171", current.info.id, "current")
  const stored = sessions([old, oldReply, continuation, continuationReply, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ turns: 1, parts: 2, tokens: 4 })
  expect(stored.updates).toHaveLength(0)
})

test("keeps the raw turn boundary when a retained pre-summary tail is projected", async () => {
  const first = user("180")
  const firstReply = assistant("181", first.info.id, "first")
  const second = user("190")
  const secondReply = assistant("191", second.info.id, "second")
  const compact = user("200")
  compact.parts = [
    {
      id: PartID.make("prt_compact-tail"),
      sessionID,
      messageID: compact.info.id,
      type: "compaction",
      auto: false,
      tail_start_id: second.info.id,
    },
  ]
  const summaryPart = reasoning("retained-summary", "summary", undefined, 2)
  summaryPart.messageID = MessageID.make("msg_retained-summary")
  const summary = assistantWithParts("retained-summary", compact.info.id, [summaryPart], true)
  const current = user("210")
  const currentReply = assistant("211", current.info.id, "current")
  const stored = sessions([first, firstReply, second, secondReply, compact, summary, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result.parts).toBe(1)
  expect(result.turns).toBe(1)
})

test("clears an assistant-start retained tail even when its user parent is trimmed", async () => {
  const old = user("220")
  const oldReply = assistant("221", old.info.id, "old")
  const compact = user("230")
  compact.parts = [
    {
      id: PartID.make("prt_compact-assistant-tail"),
      sessionID,
      messageID: compact.info.id,
      type: "compaction",
      auto: false,
      tail_start_id: oldReply.info.id,
    },
  ]
  const summary = assistantWithParts(
    "assistant-tail-summary",
    compact.info.id,
    [reasoning("tail-summary", "summary", undefined, 2)],
    true,
  )
  const current = user("240")
  const currentReply = assistant("241", current.info.id, "current")
  const stored = sessions([old, oldReply, compact, summary, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ parts: 1, turns: 1 })
})

test("counts multiple assistant steps under one user turn", async () => {
  const old = user("250")
  const first = reasoning("step-one", "one", undefined, 2)
  first.messageID = MessageID.make("msg_steps")
  const second = reasoning("step-two", "two", undefined, 2)
  second.messageID = MessageID.make("msg_steps")
  const steps = assistantWithParts("steps", old.info.id, [first, second])
  const current = user("260")
  const currentReply = assistant("261", current.info.id, "current")
  const stored = sessions([old, steps, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ turns: 1, parts: 2, tokens: 2 })
})

test("uses raw message order for equal timestamps and imported IDs", async () => {
  const first = user("import-z")
  const second = user("import-a")
  first.info.time.created = 500
  second.info.time.created = 500
  const firstReply = assistant("import-z-reply", first.info.id, "first")
  const secondReply = assistant("import-a-reply", second.info.id, "second")
  const stored = sessions([first, firstReply, second, secondReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result.parts).toBe(1)
  expect(result.turns).toBe(1)
})

test("reports zero work for a session with no real user turns", async () => {
  const synthetic = user("270")
  ;(synthetic.parts[0] as SessionV1.TextPart).synthetic = true
  const stored = sessions([synthetic])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ turns: 0, parts: 0, tokens: 0 })
})

test("reports empty reasoning with an explicitly empty metadata object as unsupported", async () => {
  const old = user("275")
  const empty = assistantWithParts("276", old.info.id, [reasoning("empty-metadata", "", {}, 2)])
  const current = user("277")
  const currentReply = assistant("278", current.info.id, "current")
  const stored = sessions([old, empty, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result.unsupported).toBe(1)
  expect(result.parts).toBe(0)
  const applied = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: result.token, sessions: stored.service }),
  )
  expect(applied).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(0)
})

test("does not report empty reasoning without metadata as unsupported", async () => {
  const old = user("276")
  const empty = assistantWithParts("277", old.info.id, [reasoning("empty-plain", "   ", undefined, 2)])
  const current = user("278")
  const currentReply = assistant("279", current.info.id, "current")
  const stored = sessions([old, empty, current, currentReply])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(preview).toMatchObject({ parts: 0, turns: 0, unsupported: 0 })
  const applied = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )
  expect(applied).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(0)
})

test("reports OpenRouter tool reasoning details as unsupported regardless of payload shape", async () => {
  const old = user("279")
  const toolMessage = MessageID.make("msg_tool-reasoning-details")
  const tool: SessionV1.ToolPart = {
    id: PartID.make("prt_tool-reasoning-details"),
    sessionID,
    messageID: toolMessage,
    type: "tool",
    callID: "call-tool-reasoning-details",
    tool: "search",
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "search",
      metadata: {},
      time: { start: 1, end: 2 },
    },
    metadata: { openrouter: { reasoning_details: { signature: "opaque" } } },
  }
  const toolReply = assistantWithParts("tool-reasoning-details", old.info.id, [tool])
  toolReply.info.id = toolMessage
  const current = user("289")
  const currentReply = assistant("290", current.info.id, "current")
  const stored = sessions([old, toolReply, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result.unsupported).toBe(1)
  expect(result.parts).toBe(0)
})

test("ignores unsupported carriers in kept turns and clears older parts", async () => {
  const old = user("291")
  const oldReply = assistant("292", old.info.id, "clear me")
  const current = user("293")
  const currentReply = assistant("294", current.info.id, "current")
  const keptTool: SessionV1.ToolPart = {
    id: PartID.make("prt_kept-tool-reasoning-details"),
    sessionID,
    messageID: currentReply.info.id,
    type: "tool",
    callID: "call-kept-tool-reasoning-details",
    tool: "search",
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "search",
      metadata: {},
      time: { start: 1, end: 2 },
    },
    metadata: { openrouter: { reasoning_details: [] } },
  }
  currentReply.parts.push(keptTool)
  const stored = sessions([old, oldReply, current, currentReply])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(preview).toMatchObject({ parts: 1, unsupported: 0 })
  const result = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )
  expect(result).toMatchObject({ parts: 1, turns: 1 })
  expect(stored.updates).toHaveLength(1)
})

test("treats malformed reasoning metadata as unsupported instead of dropping it", async () => {
  const old = user("295")
  const malformed = reasoning("malformed-metadata", "clear me", [] as unknown as Record<string, unknown>, 2)
  const reply = assistantWithParts("296", old.info.id, [malformed])
  const current = user("297")
  const currentReply = assistant("298", current.info.id, "current")
  const stored = sessions([old, reply, current, currentReply])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(result).toMatchObject({ parts: 0, unsupported: 1 })
  const applied = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: result.token, sessions: stored.service }),
  )
  expect(applied).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(0)
})

test("rejects a stale preview before writing any target part", async () => {
  const old = user("280")
  const oldReply = assistant("281", old.info.id, "old")
  const current = user("290")
  const currentReply = assistant("291", current.info.id, "current")
  const stored = sessions([old, oldReply, current, currentReply])
  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  ;(oldReply.parts[0] as SessionV1.ReasoningPart).text = "changed after preview"
  stored.stored.set(oldReply.parts[0]!.id, oldReply.parts[0]!)

  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service })),
  ).rejects.toThrow("stale")
  expect(stored.updates).toHaveLength(0)
})
