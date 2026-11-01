import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as Clear from "@/kilocode/session/tool-clear"
import { ToolClearPayload, ToolClearPreviewPayload } from "@/kilocode/server/httpapi/groups/session"
import { Token } from "@/util/token"

const sessionID = SessionID.make("ses_tool_clear")

test("requires integer ranges in tool-clear schemas", () => {
  const decodePreview = Schema.decodeUnknownSync(ToolClearPreviewPayload)
  const decodeApply = Schema.decodeUnknownSync(ToolClearPayload)
  const decodePreviewResult = Schema.decodeUnknownSync(Clear.PreviewResult)
  const decodeApplyResult = Schema.decodeUnknownSync(Clear.ApplyResult)
  const preview = { turns: 0, parts: 0, tokens: 0, token: "token" }
  const apply = { parts: 0, turns: 0, tokens: 0 }

  expect(decodePreview({ keepTurns: 1 })).toEqual({ keepTurns: 1 })
  expect(decodePreview({ keepTurns: 100 })).toEqual({ keepTurns: 100 })
  expect(() => decodePreview({ keepTurns: 0 })).toThrow()
  expect(() => decodePreview({ keepTurns: 101 })).toThrow()
  expect(() => decodePreview({ keepTurns: 1.5 })).toThrow()
  expect(decodeApply({ keepTurns: 10, token: "t" })).toEqual({ keepTurns: 10, token: "t" })
  expect(() => decodeApply({ keepTurns: 10 })).toThrow()
  expect(() => decodeApply({ keepTurns: 10, token: 5 })).toThrow()

  expect(decodePreviewResult(preview)).toEqual(preview)
  expect(() => decodePreviewResult({ ...preview, parts: -1 })).toThrow()
  expect(() => decodePreviewResult({ ...preview, tokens: 1.5 })).toThrow()
  expect(decodeApplyResult(apply)).toEqual(apply)
  expect(() => decodeApplyResult({ ...apply, turns: -1 })).toThrow()
})

function user(id: string, parts: SessionV1.Part[] = []): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "code",
      model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
    },
    parts: parts.length
      ? parts
      : [{ id: PartID.make(`prt_${id}`), sessionID, messageID, type: "text", text: `turn ${id}` }],
  }
}

function tool(
  id: string,
  output: string,
  opts: { name?: string; compacted?: number; metadata?: Record<string, unknown> } = {},
): SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted } {
  return {
    id: PartID.make(`prt_${id}`),
    messageID: MessageID.make("msg_unset"),
    sessionID,
    type: "tool",
    callID: `call_${id}`,
    tool: opts.name ?? "bash",
    state: {
      status: "completed",
      input: {},
      title: "bash",
      output,
      metadata: opts.metadata ?? {},
      time: { start: 1, end: 2, ...(opts.compacted === undefined ? {} : { compacted: opts.compacted }) },
    },
  }
}

function reply(
  id: string,
  parentID: MessageID,
  parts: SessionV1.Part[],
  summary?: { finish: string },
): SessionV1.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  for (const part of parts) part.messageID = messageID
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID,
      mode: "code",
      agent: "code",
      modelID: ModelV2.ID.make("model"),
      providerID: ProviderV2.ID.make("provider"),
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: summary?.finish ?? "stop",
      ...(summary ? { summary: true } : {}),
    },
    parts,
  }
}

function sessions(messages: SessionV1.WithParts[], raw = messages.flatMap((message) => message.parts)) {
  const stored = new Map(raw.map((part) => [part.id, part]))
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
        return Effect.succeed(part)
      },
    } as unknown as import("@/session/session").Session.Interface,
  }
}

function compacted(part: SessionV1.Part | undefined) {
  if (part?.type !== "tool" || part.state.status !== "completed") return undefined
  return part.state.time.compacted
}

test("previews only completed, unprotected, uncleared output outside the kept turns", () => {
  const old = tool("old", "o".repeat(400))
  const protectedPart = tool("skill", "s".repeat(400), { name: "skill" })
  const cleared = tool("cleared", "c".repeat(400), { compacted: 5 })
  const running = {
    ...tool("running", "unused"),
    state: { status: "running", input: {}, time: { start: 1 } },
  } as SessionV1.ToolPart
  const middle = tool("middle", "m".repeat(200))
  const current = tool("current", "n".repeat(800))
  const first = user("1")
  const second = user("2")
  const third = user("3")
  const stored = sessions([
    first,
    reply("1a", first.info.id, [old, protectedPart, cleared, running]),
    second,
    reply("2a", second.info.id, [middle]),
    third,
    reply("3a", third.info.id, [current]),
  ])

  return expect(
    Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service })),
  ).resolves.toEqual({
    parts: 2,
    turns: 2,
    tokens: Token.estimate(old.state.output) + Token.estimate(middle.state.output),
    token: expect.any(String),
  })
})

test("keeping more turns than exist previews nothing", async () => {
  const first = user("1")
  const stored = sessions([first, reply("1a", first.info.id, [tool("only", "x".repeat(400))])])

  const result = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 5, sessions: stored.service }))

  expect(result).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
})

test("marks the stored part and keeps the metadata the projection strips", async () => {
  const raw = tool("raw", "old output", { metadata: { diff: "full diff", filediff: { patch: "patch" } } })
  const projected = MessageV2.stripPartMetadata(raw)
  expect(projected).not.toBe(raw)
  const first = user("1")
  const second = user("2")
  const stored = sessions(
    [first, reply("1a", first.info.id, [projected]), second, reply("2a", second.info.id, [tool("current", "current")])],
    [raw],
  )

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  const result = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )

  expect(result).toEqual({ parts: 1, turns: 1, tokens: Token.estimate("old output") })
  expect(stored.updates).toHaveLength(1)
  expect(stored.updates[0]).toBe(raw)
  expect(compacted(raw)).toEqual(expect.any(Number))
  expect(raw.state.metadata).toEqual({ diff: "full diff", filediff: { patch: "patch" } })
})

test("rejects a stale preview and a repeated apply", async () => {
  const first = user("1")
  const second = user("2")
  const one = tool("one", "x".repeat(400))
  const messages = [
    first,
    reply("1a", first.info.id, [one]),
    second,
    reply("2a", second.info.id, [tool("current", "current")]),
  ]
  const stored = sessions(messages)
  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  const added = tool("added", "y".repeat(400))
  added.messageID = MessageID.make("msg_1a")
  messages[1]!.parts.push(added)
  stored.stored.set(added.id, added)
  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service })),
  ).rejects.toThrow("stale")
  expect(stored.updates).toHaveLength(0)

  const fresh = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(fresh).toMatchObject({ parts: 2 })
  await Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: fresh.token, sessions: stored.service }))
  expect(stored.updates).toHaveLength(2)

  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: fresh.token, sessions: stored.service })),
  ).rejects.toThrow("stale")
  expect(stored.updates).toHaveLength(2)
  const after = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(after).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
})

test("reaches a tail retained before the latest summary but not the current turn", async () => {
  const tail = user("tail")
  const retained = tool("retained", "r".repeat(400))
  const compact = user("compact", [
    {
      id: PartID.make("prt_compaction"),
      sessionID,
      messageID: MessageID.make("msg_compact"),
      type: "compaction",
      auto: false,
      tail_start_id: tail.info.id,
    },
  ])
  const next = user("next")
  const current = tool("current", "c".repeat(400))
  const stored = sessions([
    tail,
    reply("tail_reply", tail.info.id, [retained]),
    compact,
    reply("summary", compact.info.id, [], { finish: "stop" }),
    next,
    reply("current_reply", next.info.id, [current]),
  ])

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  await Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }))

  expect(stored.updates.map((part) => String(part.id))).toEqual([String(retained.id)])
  expect(compacted(current)).toBeUndefined()
})

test("reports only the outputs it actually cleared when a stored part is gone", async () => {
  const first = user("1")
  const second = user("2")
  const kept = tool("kept", "k".repeat(400))
  const gone = tool("gone", "g".repeat(400))
  const stored = sessions(
    [
      first,
      reply("1a", first.info.id, [kept, gone]),
      second,
      reply("2a", second.info.id, [tool("current", "current")]),
    ],
    [kept],
  )

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  expect(preview).toMatchObject({ parts: 2 })
  const result = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: stored.service }),
  )

  expect(result).toEqual({ parts: 1, turns: 1, tokens: Token.estimate(kept.state.output) })
  expect(stored.updates.map((part) => String(part.id))).toEqual([String(kept.id)])
})

test("propagates a part write failure", async () => {
  const first = user("1")
  const second = user("2")
  const a = tool("a", "x".repeat(400))
  const b = tool("b", "y".repeat(400))
  const stored = sessions([
    first,
    reply("1a", first.info.id, [a, b]),
    second,
    reply("2a", second.info.id, [tool("current", "current")]),
  ])
  const update = stored.service.updatePart
  const service = {
    ...stored.service,
    updatePart: ((part: SessionV1.Part) => {
      if (part.id === b.id) return Effect.fail(new Error("write failed"))
      return update(part)
    }) as typeof stored.service.updatePart,
  } as typeof stored.service

  const preview = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: service }))
  await expect(
    Effect.runPromise(Clear.apply({ sessionID, keepTurns: 1, token: preview.token, sessions: service })),
  ).rejects.toThrow("write failed")
  expect(stored.updates.map((part) => String(part.id))).toEqual([String(a.id)])
})
