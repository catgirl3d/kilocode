import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { MessageID, PartID } from "@/session/schema"
import * as Shake from "@/kilocode/session/shake"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { Token } from "@/util/token"
import { ProviderTest } from "../../fake/provider"

const sessionID = SessionID.make("ses_shake_test")

function tool(id: string, output: string, name = "bash", compacted?: number): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${id}`),
    messageID: MessageID.make(`msg_${id}`),
    sessionID,
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    state: {
      status: "completed",
      input: {},
      title: name,
      output,
      metadata: {},
      time: { start: 1, end: 2, ...(compacted === undefined ? {} : { compacted }) },
    },
  }
}

function message(
  id: string,
  role: "user" | "assistant",
  parts: SessionV1.Part[],
  summary = false,
  completed = false,
  parent = "user",
): SessionV1.WithParts {
  return {
    info: {
      id: `msg_${id}`,
      sessionID,
      role,
      time: { created: 1 },
      ...(role === "assistant"
        ? {
            parentID: `msg_${parent}`,
            mode: "code",
            agent: "code",
            modelID: "model",
            providerID: "provider",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
        : { agent: "code", model: { providerID: "provider", modelID: "model" } }),
      ...(summary ? { summary: true, ...(completed ? { finish: "stop" } : {}) } : {}),
    },
    parts,
  } as SessionV1.WithParts
}

function run(messages: SessionV1.WithParts[], raw = messages.flatMap((message) => message.parts)) {
  const updates: SessionV1.ToolPart[] = []
  const stored = new Map(raw.map((part) => [part.id, part]))
  const sessions = {
    messages: () => Effect.succeed(messages),
    getPart: ({ partID }: { partID: PartID }) => Effect.succeed(stored.get(partID)),
    updatePart: (part: SessionV1.ToolPart) => {
      updates.push(part)
      stored.set(part.id, part)
      return Effect.succeed(part)
    },
  }
  return {
    updates,
    result: Effect.runPromise(Shake.run({ sessionID, sessions: sessions as unknown as import("@/session/session").Session.Interface }).pipe(Effect.orDie)),
  }
}

function compacted(part: SessionV1.ToolPart) {
  return part.state.status === "completed" ? part.state.time.compacted : undefined
}

function output(part: SessionV1.ToolPart) {
  if (part.state.status !== "completed") throw new Error("expected completed tool")
  return part.state.output
}

function text(id: string, value: string): SessionV1.TextPart {
  return {
    id: PartID.make(`prt_${id}`),
    messageID: MessageID.make(`msg_${id}`),
    sessionID,
    type: "text",
    text: value,
  }
}

function compaction(id: string, tail: string): SessionV1.CompactionPart {
  return {
    id: PartID.make(`prt_${id}`),
    messageID: MessageID.make(`msg_${id}`),
    sessionID,
    type: "compaction",
    auto: false,
    tail_start_id: MessageID.make(`msg_${tail}`),
  }
}

test("marks the raw stored part without discarding sanitized metadata", async () => {
  const raw = tool("raw", "old output")
  if (raw.state.status !== "completed") throw new Error("expected completed tool")
  raw.state.metadata = {
    diff: "full diff",
    filediff: { before: "before", after: "after", patch: "patch" },
  }
  const projected = MessageV2.stripPartMetadata(raw)
  const newer = Array.from({ length: 7 }, (_, index) => tool(`newer_${index}`, "new output"))
  const { updates, result } = run(
    [message("user", "user", []), message("assistant", "assistant", [projected, ...newer])],
    [raw, ...newer],
  )

  await expect(result).resolves.toMatchObject({ parts: 1 })
  expect(updates).toHaveLength(1)
  expect(updates[0]).toBe(raw)
  if (raw.state.status !== "completed") throw new Error("expected completed tool")
  expect(raw.state.metadata).toEqual({
    diff: "full diff",
    filediff: { before: "before", after: "after", patch: "patch" },
  })
})

describe("manual session shake", () => {
  test("keeps exactly the seven newest eligible outputs and counts only cleared outputs", async () => {
    const one = tool("one", "one")
    const two = tool("two", "two-two")
    const three = tool("three", "three-three-three")
    const four = tool("four", "four-four-four-four")
    const five = tool("five", "five-five-five-five-five")
    const six = tool("six", "six-six-six-six-six-six")
    const seven = tool("seven", "seven-seven-seven-seven-seven-seven-seven")
    const eight = tool("eight", "eight-eight-eight-eight-eight-eight-eight-eight")
    const nine = tool("nine", "nine-nine-nine-nine-nine-nine-nine-nine-nine")
    const { updates, result } = run([
      message("user_1", "user", []),
      message("assistant_1", "assistant", [one, two]),
      message("user_2", "user", []),
      message("assistant_2", "assistant", [three, four, five, six, seven, eight, nine]),
    ])

    await expect(result).resolves.toMatchObject({
      parts: 2,
      tokens: Token.estimate(output(two)) + Token.estimate(output(one)),
      diagnostics: { candidates: 9 },
    })
    expect(updates.map((part) => part.id)).toEqual([two.id, one.id])
    expect([three, four, five, six, seven, eight, nine].map(compacted)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect([one, two].map(compacted)).toEqual([expect.any(Number), expect.any(Number)])
  })

  test("clears small and latest outputs while preserving protected parts", async () => {
    const old = tool("old", "x".repeat(180_000))
    const middle = Array.from({ length: 6 }, (_, index) => tool(`middle_${index}`, `middle ${index}`))
    const protectedPart = tool("skill", "x".repeat(180_000), "skill")
    const recent = tool("recent", "small output")
    const { updates, result } = run([
      message("user_1", "user", []),
      message("assistant_1", "assistant", [old, ...middle, protectedPart]),
      message("user_2", "user", []),
      message("assistant_2", "assistant", []),
      message("user_3", "user", []),
      message("assistant_3", "assistant", [recent]),
    ])

    await expect(result).resolves.toMatchObject({ parts: 1, tokens: expect.any(Number) })
    expect(updates.map((part) => part.id)).toEqual([old.id])
    expect(compacted(old)).toEqual(expect.any(Number))
    expect(compacted(protectedPart)).toBeUndefined()
    expect(compacted(recent)).toBeUndefined()
  })

  test("is idempotent and persists the in-place rewrite through updatePart", async () => {
    const old = tool("old", "small output")
    const middle = Array.from({ length: 6 }, (_, index) => tool(`middle_${index}`, `middle ${index}`))
    const messages = [
      message("user_1", "user", []),
      message("assistant_1", "assistant", [old, ...middle]),
      message("user_2", "user", []),
      message("assistant_2", "assistant", []),
      message("user_3", "user", []),
      message("assistant_3", "assistant", [tool("recent", "latest output")]),
    ]
    const first = run(messages)
    await first.result
    const second = run(messages)

    await expect(second.result).resolves.toMatchObject({ parts: 0, tokens: 0 })
    expect(first.updates).toHaveLength(1)
    expect(second.updates).toHaveLength(0)
    expect(messages[1].parts[0]).toBe(old)
  })

  test("returns selection diagnostics", async () => {
    const output = tool("output", "tool output")
    const other = Array.from({ length: 7 }, (_, index) => tool(`other_${index}`, `other ${index}`))

    const { result } = run([
      message("user", "user", []),
      message("assistant", "assistant", [output, ...other]),
    ])
    await expect(result).resolves.toMatchObject({
      parts: 1,
      diagnostics: {
        rawMessages: 2,
        projectionMessages: 2,
        tools: 8,
        completed: 8,
        protected: 0,
        compacted: 0,
        candidates: 8,
      },
    })
  })

  test("skips an already-compacted sibling and cleans another visible candidate", async () => {
    const visible = Array.from({ length: 8 }, (_, index) => tool(`visible_${index}`, `visible output ${index}`))
    const boundary = tool("boundary", "already cleared output", "bash", 10)
    const { updates, result } = run([
      message("user_1", "user", []),
      message("assistant_1", "assistant", [boundary, ...visible]),
    ])

    await expect(result).resolves.toMatchObject({ parts: 1, tokens: expect.any(Number) })
    expect(updates).toEqual([visible[0]])
    expect(compacted(visible[0])).toEqual(expect.any(Number))
    expect(compacted(boundary)).toBe(10)
  })

  test("clears eligible output in a retained pre-summary tail", async () => {
    const retained = tool("retained", "retained output")
    const current = Array.from({ length: 7 }, (_, index) => tool(`current_${index}`, `current output ${index}`))
    const messages = [
      message("tail", "user", []),
      message("tail_reply", "assistant", [retained]),
      message("compact", "user", [compaction("compact", "tail")]),
      message("summary", "assistant", [], true, true, "compact"),
      message("next", "user", []),
      message("current", "assistant", current),
    ]

    const projected = KiloSessionPrompt.trimBeforeLastSummary(MessageV2.filterCompacted([...messages].reverse()))
    expect(projected.map((item) => item.info.id)).toContain(MessageID.make("msg_tail_reply"))

    const { updates, result } = run(messages)
    await expect(result).resolves.toMatchObject({ parts: 1, tokens: expect.any(Number) })
    expect(updates.map((part) => part.id)).toEqual([retained.id])
    expect(compacted(retained)).toEqual(expect.any(Number))
    expect(current.map(compacted)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })

  test("does not cross the latest completed compaction summary", async () => {
    const old = tool("old", "old history")
    const current = Array.from({ length: 8 }, (_, index) => tool(`current_${index}`, `current output ${index}`))
    const { updates, result } = run([
      message("user_0", "user", []),
      message("assistant_0", "assistant", [old]),
      message("summary_user", "user", []),
      message("summary", "assistant", [], true, true, "summary_user"),
      message("user_1", "user", []),
      message("assistant_1", "assistant", current),
    ])

    await expect(result).resolves.toMatchObject({ parts: 1, tokens: expect.any(Number) })
    expect(updates).toEqual([current[0]])
    expect(compacted(old)).toBeUndefined()
    expect(compacted(current[0])).toEqual(expect.any(Number))
  })

  test("keeps tool-call pairing while rebuilding cleared model output", async () => {
    const old = tool("old", "original tool output")
    const filler = Array.from({ length: 7 }, (_, index) => tool(`filler_${index}`, `filler ${index}`))
    const messages = [
      message("user_1", "user", [text("request", "run the tool")]),
      message("assistant_1", "assistant", filler),
      message("user_2", "user", []),
      message("assistant_2", "assistant", []),
      message("user_3", "user", []),
      message("assistant_3", "assistant", [old]),
    ]

    await run(messages).result
    const modelMessages = await MessageV2.toModelMessages(messages, ProviderTest.model())
    const assistant = modelMessages.find(
      (item) => item.role === "assistant" && Array.isArray(item.content) && item.content.some((part) => part.type === "tool-call"),
    )
    const toolMessage = modelMessages.find((item) => item.role === "tool")
    if (!assistant || !toolMessage || toolMessage.role !== "tool") throw new Error("expected tool call and result")
    if (!Array.isArray(assistant.content) || !Array.isArray(toolMessage.content)) {
      throw new Error("expected tool call and result arrays")
    }
    const call = assistant.content.find((part) => part.type === "tool-call")
    const result = toolMessage.content.find((part) => part.type === "tool-result")
    if (!call || call.type !== "tool-call" || !result || result.type !== "tool-result") {
      throw new Error("expected tool call and result content")
    }

    expect(result.toolCallId).toBe(call.toolCallId)
    expect(result.output).toEqual({ type: "text", value: "[Old tool result content cleared]" })
  })
})
