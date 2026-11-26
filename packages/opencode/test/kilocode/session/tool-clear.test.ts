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
  expect(decodePreview({ keepTurns: 1, includeHistory: true })).toEqual({ keepTurns: 1, includeHistory: true })
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
  opts: {
    name?: string
    compacted?: number
    metadata?: Record<string, unknown>
    partMetadata?: Record<string, unknown>
    input?: Record<string, unknown>
  } = {},
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
      input: opts.input ?? {},
      title: "bash",
      output,
      metadata: opts.metadata ?? {},
      time: { start: 1, end: 2, ...(opts.compacted === undefined ? {} : { compacted: opts.compacted }) },
    },
    ...(opts.partMetadata ? { metadata: opts.partMetadata } : {}),
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
      getPart: ({ partID, messageID }: { partID: PartID; messageID: MessageID }) => {
        const part = stored.get(partID)
        if (!part || part.messageID !== messageID) return Effect.succeed(undefined)
        return Effect.succeed(part)
      },
      updatePart: (part: SessionV1.Part) => {
        updates.push(part)
        stored.set(part.id, part)
        for (const message of messages) {
          const index = message.parts.findIndex((item) => item.id === part.id)
          if (index !== -1) message.parts[index] = part
        }
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

test("history preview targets compacted output that output-only clear skips", async () => {
  const first = user("history-compacted-1")
  const compactedPart = tool("history-compacted", "old output".repeat(100), {
    compacted: 5,
    input: { command: "old command".repeat(100) },
  })
  const second = user("history-compacted-2")
  const stored = sessions([
    first,
    reply("history-compacted-reply", first.info.id, [compactedPart]),
    second,
    reply("history-compacted-current", second.info.id, [tool("history-compacted-current", "current")]),
  ])

  const outputOnly = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  const history = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )

  expect(outputOnly).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
  expect(history).toEqual({
    parts: 1,
    turns: 1,
    tokens:
      Token.estimate(JSON.stringify(compactedPart.state.input)) +
      Token.estimate("[Old tool result content cleared]") -
      Token.estimate("[Old bash call and result cleared]"),
    token: expect.any(String),
  })
})

test("history preview finds projected tool parts that lost their message id", async () => {
  const first = user("history-projected-1")
  const raw = tool("history-projected", "projected output", {
    compacted: 5,
    input: { command: "projected command" },
  })
  const projected = { ...raw, messageID: undefined } as unknown as SessionV1.Part
  const replyMessage = reply("history-projected-reply", first.info.id, [projected])
  raw.messageID = replyMessage.info.id
  const second = user("history-projected-2")
  const current = tool("history-projected-current", "current")
  const stored = sessions(
    [first, replyMessage, second, reply("history-projected-current-reply", second.info.id, [current])],
    [raw, current],
  )

  const preview = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, includeHistory: true, token: preview.token, sessions: stored.service }),
  )

  expect(preview).toMatchObject({ parts: 1, turns: 1 })
  expect(stored.updates.map((part) => String(part.id))).toEqual([String(raw.id)])
})

test("history preview targets compacted and live tools from one safe assistant message", async () => {
  const first = user("history-both-1")
  const compactedPart = tool("history-both-compacted", "compacted output".repeat(100), {
    compacted: 5,
    input: { command: "compacted command".repeat(100) },
  })
  const livePart = tool("history-both-live", "live output".repeat(100), {
    input: { command: "live command".repeat(100) },
  })
  const second = user("history-both-2")
  const stored = sessions([
    first,
    reply("history-both-reply", first.info.id, [compactedPart, livePart]),
    second,
    reply("history-both-current", second.info.id, [tool("history-both-current", "current")]),
  ])

  const result = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )

  expect(result).toEqual({
    parts: 2,
    turns: 1,
    tokens:
      Token.estimate(JSON.stringify(compactedPart.state.input)) +
      Token.estimate("[Old tool result content cleared]") -
      Token.estimate("[Old bash call and result cleared]") +
      Token.estimate(JSON.stringify(livePart.state.input)) +
      Token.estimate(livePart.state.output) -
      Token.estimate("[Old bash call and result cleared]"),
    token: expect.any(String),
  })
})

test("history preview skips unsafe assistant messages without clearing safe siblings", async () => {
  const first = user("history-unsafe-1")
  const providerMessage = reply("history-unsafe-provider", first.info.id, [
    tool("history-unsafe-provider-target", "target".repeat(100), { input: { command: "target".repeat(100) } }),
    tool("history-unsafe-provider-meta", "provider", {
      partMetadata: { openai: { itemId: "x" } },
    }),
    {
      id: PartID.make("prt_history-unsafe-provider-text-meta"),
      messageID: MessageID.make("msg_unset"),
      sessionID,
      type: "text",
      text: "provider metadata",
      metadata: { openai: { itemId: "x" } },
    },
  ])
  const second = user("history-unsafe-2")
  const skillMessage = reply("history-unsafe-skill", second.info.id, [
    tool("history-unsafe-skill-target", "target".repeat(100)),
    tool("history-unsafe-skill-meta", "skill", { name: "skill" }),
  ])
  const third = user("history-unsafe-3")
  const unfinished = {
    ...tool("history-unsafe-running-target", "target".repeat(100)),
    state: { status: "running", input: {}, time: { start: 1 } },
  } as SessionV1.ToolPart
  const unfinishedMessage = reply("history-unsafe-running", third.info.id, [
    tool("history-unsafe-running-sibling", "target".repeat(100)),
    unfinished,
  ])
  const fourth = user("history-unsafe-4")
  const executedMessage = reply("history-unsafe-executed", fourth.info.id, [
    tool("history-unsafe-executed-target", "target".repeat(100)),
    tool("history-unsafe-executed-meta", "executed", { metadata: { providerExecuted: true } }),
  ])
  const fifth = user("history-unsafe-5")
  const current = tool("history-unsafe-current", "current")
  const stored = sessions([
    first,
    providerMessage,
    second,
    skillMessage,
    third,
    unfinishedMessage,
    fourth,
    executedMessage,
    fifth,
    reply("history-unsafe-current-reply", fifth.info.id, [current]),
  ])

  const result = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )

  expect(result).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
  const applied = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, includeHistory: true, token: result.token, sessions: stored.service }),
  )
  expect(applied).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(0)
})

test("output-only clear skips parts already hidden by history clear", async () => {
  const first = user("history-output-1")
  const raw = tool("history-output", "live output".repeat(100), {
    input: { command: "live command".repeat(100) },
  })
  const second = user("history-output-2")
  const stored = sessions([
    first,
    reply("history-output-reply", first.info.id, [raw]),
    second,
    reply("history-output-current", second.info.id, [tool("history-output-current", "current")]),
  ])

  const history = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, includeHistory: true, token: history.token, sessions: stored.service }),
  )
  const output = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))

  expect(output).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
  const applied = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, token: output.token, sessions: stored.service }),
  )
  expect(applied).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(1)
})

test("history apply persists only its marker and invalidates after input or mode changes", async () => {
  const first = user("history-apply-1")
  const input = { command: "original".repeat(100) }
  const raw = tool("history-apply", "original output".repeat(100), { compacted: 5, input })
  const second = user("history-apply-2")
  const stored = sessions([
    first,
    reply("history-apply-reply", first.info.id, [raw]),
    second,
    reply("history-apply-current", second.info.id, [tool("history-apply-current", "current")]),
  ])

  const outputOnly = await Effect.runPromise(Clear.preview({ sessionID, keepTurns: 1, sessions: stored.service }))
  const history = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  expect(history.token).not.toBe(outputOnly.token)

  raw.state.input = { command: "changed".repeat(100) }
  const changed = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  expect(changed.token).not.toBe(history.token)

  raw.state.input = input
  const fresh = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  const result = await Effect.runPromise(
    Clear.apply({ sessionID, keepTurns: 1, includeHistory: true, token: fresh.token, sessions: stored.service }),
  )
  const marked = stored.stored.get(raw.id)

  expect(result).toEqual({ parts: 1, turns: 1, tokens: fresh.tokens })
  expect(marked).not.toBe(raw)
  expect(marked?.type).toBe("tool")
  if (marked?.type !== "tool" || marked.state.status !== "completed") throw new Error("history marker missing")
  expect(marked.state.input).toEqual(input)
  expect(marked.state.output).toBe(raw.state.output)
  expect(marked.state.time.compacted).toBe(5)
  expect(typeof marked.state.metadata["kilocode.toolHistory"]?.cleared).toBe("number")
  expect(stored.updates).toHaveLength(1)

  const secondPreview = await Effect.runPromise(
    Clear.preview({ sessionID, keepTurns: 1, includeHistory: true, sessions: stored.service }),
  )
  expect(secondPreview).toMatchObject({ parts: 0, turns: 0, tokens: 0 })
  const secondApply = await Effect.runPromise(
    Clear.apply({
      sessionID,
      keepTurns: 1,
      includeHistory: true,
      token: secondPreview.token,
      sessions: stored.service,
    }),
  )
  expect(secondApply).toEqual({ parts: 0, turns: 0, tokens: 0 })
  expect(stored.updates).toHaveLength(1)
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
  const old = reply("1a", first.info.id, [projected])
  raw.messageID = old.info.id
  const stored = sessions([first, old, second, reply("2a", second.info.id, [tool("current", "current")])], [raw])

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
