import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Session } from "../../../src/session/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionSummary } from "../../../src/session/summary"
import { Snapshot } from "../../../src/snapshot"
import { BackgroundJob } from "../../../src/background/job"
import { SessionDrain } from "../../../src/kilocode/session/drain"
import { KiloSessionPromptQueue } from "../../../src/kilocode/session/prompt-queue"
import { provideTmpdirServer } from "../../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { reply } from "../../lib/llm-server"
import { config, events, layer, recording, reset, trackCount } from "./fixture"

const it = testEffect(layer(recording))
const actual = testEffect(layer())
const background = testEffect(
  Layer.mergeAll(layer(recording), LayerNode.compile(LayerNode.group([BackgroundJob.node, SessionDrain.node]))),
)

describe("lazy snapshot mutation integration", () => {
  it.live(
    "does not track a text and reasoning-only turn",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          reset()
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.reason("thinking", { text: "ordinary answer" })
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(parts.some((part) => part.type === "reasoning")).toBe(true)
          expect(events).toEqual([])
          const assistant = (yield* MessageV2.filterCompactedEffect(session.id)).findLast(
            (item) => item.info.role === "assistant",
          )
          expect(assistant?.info.role === "assistant" ? assistant.info.cost : undefined).toBe(0)
        }),
        { git: true, config },
      ),
    { timeout: 30_000 },
  )

  it.live(
    "keeps successful read and parser-approved bash read at zero tracks",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "read.txt")
          yield* Effect.promise(() => fs.writeFile(file, "readable"))
          reset()
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("read", { filePath: file })
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "read it" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("readable")
          expect(events).toEqual([])

          reset()
          const bash = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("bash", { command: "git status" })
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: bash.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "inspect status" }],
          })
          yield* prompt.loop({ sessionID: bash.id, snapshotInitialization: "wait" })
          expect(events).toEqual([])
          const parts = (yield* MessageV2.filterCompactedEffect(bash.id)).flatMap((item) => item.parts)
          expect(
            parts.some((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed"),
          ).toBe(true)
        }),
        { git: true, config },
      ),
    { timeout: 30_000 },
  )

  it.live(
    "records the write baseline before the side effect and final after it",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "created.txt")
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("write", { filePath: file, content: "created" })
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write it" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          expect(events).toHaveLength(2)
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("created")
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(parts.some((part) => part.type === "step-start" && part.snapshot === events[0]?.hash)).toBe(true)
          expect(parts.some((part) => part.type === "step-finish" && part.snapshot === events[1]?.hash)).toBe(true)
        }),
        { git: true, config },
      ),
    { timeout: 30_000 },
  )

  actual.live(
    "persists completed root write diffs on the originating user message",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "changed.txt")
          yield* Effect.promise(() => fs.writeFile(file, "before\nremoved\nafter\n"))
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          const summary = yield* SessionSummary.Service
          const snapshot = yield* Snapshot.Service
          const origin = yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "replace one line with two" }],
          })
          const track = snapshot.track
          const summarize = summary.summarize
          const updatePart = sessions.updatePart
          const init = Promise.withResolvers<void>()
          const records: { messageID: string; phase: "initial" | "intermediate" | "checkpoint"; ok?: boolean }[] = []
          let seen = false
          let checkpoint = false
          let baseline = false
          let pending = 0
          let idle = Promise.withResolvers<void>()
          idle.resolve()
          let clean: Snapshot.FileDiff[] | undefined
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Object.assign(snapshot, { track })
              Object.assign(summary, { summarize })
              Object.assign(sessions, { updatePart })
            }),
          )
          Object.assign(snapshot, {
            track: (input: Parameters<typeof track>[0]) =>
              Effect.gen(function* () {
                if (input?.sessionID === session.id) {
                  yield* awaitWithTimeout(
                    Effect.promise(() => init.promise),
                    "initial summary did not finish before snapshot tracking",
                    "15 seconds",
                  )
                  if (!baseline) {
                    const message = yield* MessageV2.get({ sessionID: session.id, messageID: origin.info.id })
                    clean = message.info.role === "user" ? message.info.summary?.diffs : undefined
                    baseline = true
                  }
                }
                return yield* track(input)
              }),
          })
          Object.assign(summary, {
            summarize: (input: Parameters<typeof summarize>[0]) => {
              const own = input.sessionID === session.id
              const phase: "initial" | "intermediate" | "checkpoint" = checkpoint
                ? "checkpoint"
                : !seen && input.messageID === origin.info.id
                  ? "initial"
                  : "intermediate"
              if (own && phase === "initial") seen = true
              const call = own ? { messageID: input.messageID, phase, ok: false } : undefined
              if (call) records.push(call)
              if (pending === 0) idle = Promise.withResolvers<void>()
              pending++
              return summarize(input).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (call) call.ok = Exit.isSuccess(exit)
                    if (call?.phase === "initial") init.resolve()
                    pending--
                    if (pending === 0) idle.resolve()
                  }),
                ),
              )
            },
          })
          Object.assign(sessions, {
            updatePart: (input: Parameters<typeof updatePart>[0]) =>
              updatePart(input).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (input.sessionID === session.id && input.type === "step-finish" && input.snapshot)
                      checkpoint = true
                  }),
                ),
              ),
          })
          yield* llm.tool("write", { filePath: file, content: "before\nadded one\nadded two\nafter\n" })
          yield* llm.text("done")
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          yield* awaitWithTimeout(
            Effect.promise(() => idle.promise),
            "session summaries did not complete",
            "15 seconds",
          )
          expect(clean).toEqual([])
          expect(records.filter((item) => item.phase === "initial")).toHaveLength(1)
          expect(records.filter((item) => item.phase === "intermediate")).toHaveLength(0)
          expect(records.filter((item) => item.phase === "checkpoint")).toHaveLength(1)
          expect(records.map((item) => item.messageID)).toEqual([origin.info.id, origin.info.id])
          expect(records.every((item) => item.ok)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("before\nadded one\nadded two\nafter\n")

          const message = (yield* MessageV2.filterCompactedEffect(session.id)).find(
            (item) => item.info.id === origin.info.id,
          )
          expect(message?.info.role).toBe("user")
          if (!message || message.info.role !== "user") return
          expect(message.info.summary?.diffs).toContainEqual(
            expect.objectContaining({ file: "changed.txt", additions: 2, deletions: 1 }),
          )
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "shares one baseline across read->write and multiple writes",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const readable = path.join(dir, "readable.txt")
          yield* Effect.promise(() => fs.writeFile(readable, "readable"))
          const first = path.join(dir, "first.txt")
          const second = path.join(dir, "second.txt")
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.push(
            reply().tool("read", { filePath: readable }).usage({ input: 17, output: 0 }),
            reply().tool("write", { filePath: first, content: "one" }).usage({ input: 19, output: 0 }),
            reply().tool("write", { filePath: second, content: "two" }).usage({ input: 23, output: 0 }),
            reply().text("done").usage({ input: 29, output: 5 }).stop(),
          )
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "read then write twice" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([session.id, session.id])
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          const starts = parts.filter(
            (part): part is Extract<typeof part, { type: "step-start" }> => part.type === "step-start",
          )
          const anchored = starts.filter((part) => part.snapshot)
          const finishes = parts.filter(
            (part): part is Extract<typeof part, { type: "step-finish" }> => part.type === "step-finish",
          )
          expect(anchored.map((part) => part.snapshot)).toEqual([events[0]?.hash])
          expect(finishes).toHaveLength(4)
          expect(finishes.at(-1)?.snapshot).toBe(events[1]?.hash)
          expect(finishes.filter((part) => part.snapshot)).toHaveLength(1)
          expect(String(anchored[0]?.messageID)).toBe(String(events[0]?.messageID))
          expect(finishes.some((part) => part.tokens.input > 0 && part.tokens.output > 0)).toBe(true)
          expect(finishes.at(-1)).toMatchObject({
            snapshot: events[1]?.hash,
          })
          expect(finishes.at(-1)?.tokens.input).toBeGreaterThan(0)
          expect(finishes.at(-1)?.time?.end ?? 0).toBeGreaterThan(0)
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("one")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("two")
        }),
        { git: true, config },
      ),
    { timeout: 30_000 },
  )

  it.live(
    "continues from the original persisted baseline without retracking it",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "continued-first.txt")
          const second = path.join(dir, "continued-second.txt")
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("write", { filePath: first, content: "first" })
          yield* llm.text("initial response")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write the first file" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })

          const messages = yield* MessageV2.filterCompactedEffect(session.id)
          const assistant = messages.findLast((item) => item.info.role === "assistant")
          expect(assistant?.info.role).toBe("assistant")
          if (!assistant || assistant.info.role !== "assistant" || !events[0]) return
          const baseline = events[0].hash
          assistant.info.finish = undefined
          yield* sessions.updateMessage(assistant.info)

          yield* llm.tool("write", { filePath: second, content: "second" })
          yield* llm.text("continued response")
          yield* prompt.loop({
            sessionID: session.id,
            resume: assistant.info.id,
            snapshotInitialization: "wait",
          })

          expect(events).toHaveLength(3)
          expect(events.map((event) => event.sessionID)).toEqual([session.id, session.id, session.id])
          expect(events[0]?.hash).toBe(baseline)
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          expect(events[2]?.exists).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(parts.filter((part) => part.type === "step-start" && part.snapshot)).toHaveLength(1)
          expect(parts.filter((part) => part.type === "step-finish" && part.snapshot)).toHaveLength(2)
          expect(
            parts
              .filter((part): part is Extract<typeof part, { type: "step-start" }> => part.type === "step-start")
              .filter((part) => part.snapshot)
              .map((part) => part.snapshot),
          ).toEqual([baseline])
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot)
              .sort(),
          ).toEqual([events[1]?.hash, events[2]?.hash].sort())
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "does not retry a failed baseline after Continue when prior history records a write",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "failed-baseline-first.txt")
          const second = path.join(dir, "failed-baseline-second.txt")
          reset(first, 1)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("write", { filePath: first, content: "first" })
          yield* llm.text("first response")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write first file after failed snapshot" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })

          expect(trackCount()).toBe(1)
          expect(events).toEqual([])
          const assistant = (yield* MessageV2.filterCompactedEffect(session.id)).findLast(
            (item) => item.info.role === "assistant",
          )
          expect(assistant?.info.role).toBe("assistant")
          if (!assistant || assistant.info.role !== "assistant") return
          assistant.info.finish = undefined
          yield* sessions.updateMessage(assistant.info)
          yield* llm.tool("write", { filePath: second, content: "second" })
          yield* llm.text("continued response")
          yield* prompt.loop({ sessionID: session.id, resume: assistant.info.id, snapshotInitialization: "wait" })

          expect(trackCount()).toBe(1)
          expect(events).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "allows the first mutation after Continue from a parser-approved bash read",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const second = path.join(dir, "after-read-only.txt")
          reset(second)
          const match = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("git status before interruption")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(match, "bash", { command: "git status" })
          yield* llm.pushMatch(match, reply().streamError("interrupted after read"))
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "git status before interruption" }],
          })
          yield* Effect.exit(prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" }))

          const before = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(
            before.some((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed"),
          ).toBe(true)
          expect(trackCount()).toBe(0)
          expect(events).toEqual([])
          const assistant = (yield* MessageV2.filterCompactedEffect(session.id)).findLast(
            (item) => item.info.role === "assistant",
          )
          expect(assistant?.info.role).toBe("assistant")
          if (!assistant || assistant.info.role !== "assistant") return
          assistant.info.finish = undefined
          yield* sessions.updateMessage(assistant.info)
          yield* llm.tool("write", { filePath: second, content: "continued" })
          yield* llm.text("continued after read-only turn")
          yield* prompt.loop({ sessionID: session.id, resume: assistant.info.id, snapshotInitialization: "wait" })

          expect(trackCount()).toBe(2)
          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([session.id, session.id])
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-start" }> =>
                  part.type === "step-start" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([events[0]?.hash])
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([events[1]?.hash])
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("continued")
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "gives a new real prompt an independent baseline",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "prompt-first.txt")
          const second = path.join(dir, "prompt-second.txt")
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("write", { filePath: first, content: "first" })
          yield* llm.text("first response")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "first real prompt" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })

          yield* llm.tool("write", { filePath: second, content: "second" })
          yield* llm.text("second response")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "second real prompt" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })

          expect(events).toHaveLength(4)
          expect(events.map((event) => event.sessionID)).toEqual(Array(4).fill(session.id))
          expect(events[0]?.hash).not.toBe(events[2]?.hash)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-start" }> =>
                  part.type === "step-start" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([events[0]?.hash, events[2]?.hash])
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([events[1]?.hash, events[3]?.hash])
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "captures exactly one response checkpoint after a provider error",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "error-write.txt")
          const match = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("write before failure")
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(match, "write", { filePath: file, content: "written" })
          yield* llm.pushMatch(match, reply().streamError("provider failed"))
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write before failure" }],
          })
          yield* Effect.exit(prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" }))

          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([session.id, session.id])
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          const finishes = parts.filter(
            (part): part is Extract<typeof part, { type: "step-finish" }> =>
              part.type === "step-finish" && Boolean(part.snapshot),
          )
          expect(finishes).toHaveLength(1)
          expect(finishes[0]).toMatchObject({
            snapshot: events[1]?.hash,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "keeps child-session writes outside the root snapshot gate",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "child-first.txt")
          const second = path.join(dir, "child-second.txt")
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("task", {
            description: "write child files",
            prompt: "write both requested files",
            subagent_type: "general",
          })
          yield* llm.tool("write", { filePath: first, content: "one" })
          yield* llm.tool("write", { filePath: second, content: "two" })
          yield* llm.text("child done")
          yield* llm.text("parent done")
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "delegate both writes" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })

          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return
          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([parent.id, parent.id])
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("one")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("two")
          const messages = yield* MessageV2.filterCompactedEffect(parent.id)
          const parts = messages
            .filter((item) => item.info.role === "assistant" && item.info.sessionID === parent.id)
            .flatMap((item) => item.parts)
          expect(parts.filter((part) => part.type === "step-start" && part.snapshot)).toHaveLength(1)
          expect(parts.filter((part) => part.type === "step-finish" && part.snapshot)).toHaveLength(1)
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "captures partial root writes once when the response is aborted",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "abort-write.txt")
          const held = Promise.withResolvers<void>()
          let hits = 0
          const match = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("abort after writing")) return false
            hits++
            if (hits === 2) held.resolve()
            return true
          }
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(match, "write", { filePath: file, content: "partial" })
          yield* llm.pushMatch(match, reply().hang())
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "abort after writing" }],
          })
          const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" }))
          yield* Effect.promise(() => held.promise)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("partial")
          yield* Fiber.interrupt(fiber)

          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([session.id, session.id])
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          const finishes = parts.filter(
            (part): part is Extract<typeof part, { type: "step-finish" }> =>
              part.type === "step-finish" && Boolean(part.snapshot),
          )
          expect(finishes).toHaveLength(1)
          expect(finishes[0]).toMatchObject({
            snapshot: events[1]?.hash,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "finalizes a superseded root response before the replacement prompt baseline",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "superseded-first.txt")
          const second = path.join(dir, "replacement-second.txt")
          const ready = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          let calls = 0
          const active = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("first active snapshot prompt")
          const delayed = (hit: { body: Record<string, unknown> }) => {
            if (!active(hit)) return false
            calls++
            if (calls === 1) ready.resolve()
            return true
          }
          const next = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("replacement snapshot prompt")
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(active, "write", { filePath: first, content: "first" })
          yield* llm.pushMatch(delayed, reply().wait(release.promise).text("first response").stop())
          yield* llm.toolMatch(next, "write", { filePath: second, content: "second" })
          yield* llm.textMatch(next, "replacement response")
          const firstTurn = yield* Effect.forkChild(
            prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "first active snapshot prompt" }],
            }),
          )
          yield* Effect.promise(() => ready.promise)
          const secondTurn = yield* Effect.forkChild(
            prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "replacement snapshot prompt" }],
            }),
          )
          yield* pollWithTimeout(
            Effect.sync(() => (KiloSessionPromptQueue.hasFollowup(session.id) ? true : undefined)),
            "replacement prompt was not queued",
          )
          release.resolve()
          yield* Fiber.join(firstTurn)
          yield* Fiber.join(secondTurn)

          expect(events).toHaveLength(4)
          expect(events.map((event) => event.sessionID)).toEqual(Array(4).fill(session.id))
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)
          expect(events[2]?.exists).toBe(true)
          expect(events[3]?.exists).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((item) => item.parts)
          const starts = parts.filter(
            (part): part is Extract<typeof part, { type: "step-start" }> =>
              part.type === "step-start" && Boolean(part.snapshot),
          )
          const finishes = parts.filter(
            (part): part is Extract<typeof part, { type: "step-finish" }> =>
              part.type === "step-finish" && Boolean(part.snapshot),
          )
          expect(starts.map((part) => part.snapshot)).toEqual([events[0]?.hash, events[2]?.hash])
          expect(finishes.map((part) => part.snapshot).sort()).toEqual([events[1]?.hash, events[3]?.hash].sort())
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
        }),
        { git: true, config },
      ),
    { timeout: 90_000 },
  )

  background.live(
    "captures partial child writes when a slow background task is cancelled",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "background.txt")
          const release = Promise.withResolvers<void>()
          const held = Promise.withResolvers<void>()
          const fileReady = Promise.withResolvers<void>()
          let childHits = 0
          const parentPrompt = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("launch a slow child")
          const childPrompt = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("write the background file")) return false
            childHits++
            if (childHits === 2) {
              held.resolve()
              fileReady.resolve()
            }
            return true
          }
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const drain = yield* SessionDrain.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(parentPrompt, "task", {
            description: "slow background write",
            prompt: "write the background file",
            subagent_type: "general",
            background: true,
          })
          yield* llm.pushMatch(parentPrompt, reply().wait(fileReady.promise).text("background task launched").stop())
          yield* llm.pushMatch(childPrompt, reply().tool("write", { filePath: file, content: "done" }))
          yield* llm.pushMatch(childPrompt, reply().text("child done").wait(release.promise).stop())
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "launch a slow child" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })

          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return
          expect(child.parentID).toBe(parent.id)
          yield* Effect.promise(() => held.promise)
          expect(events).toHaveLength(2)
          expect(events.map((event) => event.sessionID)).toEqual([parent.id, parent.id])
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("done")

          yield* jobs.cancel(child.id)
          release.resolve()
          expect((yield* jobs.wait({ id: child.id, timeout: 15_000 })).info?.status).toBe("cancelled")
          yield* drain.wait(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
          expect(events).toHaveLength(3)
          expect(events.map((event) => event.sessionID)).toEqual([parent.id, parent.id, parent.id])
          const messages = yield* MessageV2.filterCompactedEffect(parent.id)
          const parts = messages
            .filter((item) => item.info.role === "assistant" && item.info.sessionID === parent.id)
            .flatMap((item) => item.parts)
          expect(parts.filter((part) => part.type === "step-start" && part.snapshot)).toHaveLength(1)
          expect(parts.filter((part) => part.type === "step-finish" && part.snapshot)).toHaveLength(2)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot)
              .sort(),
          ).toEqual([events[1]?.hash, events[2]?.hash].sort())
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  background.live(
    "keeps the originating gate for a mutating background-result continuation",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "continuation-background.txt")
          const next = path.join(dir, "continuation-root.txt")
          const release = Promise.withResolvers<void>()
          const held = Promise.withResolvers<void>()
          const fileReady = Promise.withResolvers<void>()
          const injected = Promise.withResolvers<void>()
          let childHits = 0
          const rootPrompt = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("start a continuation child")
          const childPrompt = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("write the background file")) return false
            childHits++
            if (childHits === 2) {
              held.resolve()
              fileReady.resolve()
            }
            return true
          }
          const resultPrompt = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("Background task completed")) return false
            injected.resolve()
            return true
          }
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const drain = yield* SessionDrain.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(rootPrompt, "task", {
            description: "background then root mutation",
            prompt: "write the background file",
            subagent_type: "general",
            background: true,
          })
          yield* llm.pushMatch(rootPrompt, reply().wait(fileReady.promise).text("child launched").stop())
          yield* llm.pushMatch(childPrompt, reply().tool("write", { filePath: file, content: "child" }))
          yield* llm.pushMatch(childPrompt, reply().text("child done").wait(release.promise).stop())
          yield* llm.pushMatch(resultPrompt, reply().tool("write", { filePath: next, content: "root" }))
          yield* llm.pushMatch(resultPrompt, reply().text("continuation complete").stop())
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "start a continuation child" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return
          yield* Effect.promise(() => held.promise)
          expect(events).toHaveLength(2)
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)

          release.resolve()
          yield* Effect.promise(() => injected.promise)
          yield* drain.wait(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("completed")
          expect(events).toHaveLength(4)
          expect(events.every((event) => event.sessionID === parent.id)).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(parent.id)).flatMap((item) => item.parts)
          expect(parts.filter((part) => part.type === "step-start" && part.snapshot)).toHaveLength(1)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot)
              .sort(),
          ).toEqual([events[1]?.hash, events[2]?.hash, events[3]?.hash].sort())
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("child")
          expect(yield* Effect.promise(() => fs.readFile(next, "utf8"))).toBe("root")

          const assistant = (yield* MessageV2.filterCompactedEffect(parent.id)).findLast(
            (item) => item.info.role === "assistant",
          )
          expect(assistant?.info.role).toBe("assistant")
          if (!assistant || assistant.info.role !== "assistant") return
          const baseline = events[0]?.hash
          assistant.info.finish = undefined
          yield* sessions.updateMessage(assistant.info)
          const continued = path.join(dir, "continued-after-background.txt")
          yield* llm.tool("write", { filePath: continued, content: "continued" })
          yield* llm.text("continued after synthetic background reply")
          yield* prompt.loop({ sessionID: parent.id, resume: assistant.info.id, snapshotInitialization: "wait" })

          expect(events).toHaveLength(5)
          expect(events[4]?.exists).toBe(true)
          expect(
            (yield* MessageV2.filterCompactedEffect(parent.id))
              .flatMap((item) => item.parts)
              .filter(
                (part): part is Extract<typeof part, { type: "step-start" }> =>
                  part.type === "step-start" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([baseline])
          expect(yield* Effect.promise(() => fs.readFile(continued, "utf8"))).toBe("continued")
        }),
        { git: true, config },
      ),
    { timeout: 90_000 },
  )

  background.live(
    "delivers an extended background job settlement once across root turns",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "extension-first.txt")
          const second = path.join(dir, "extension-second.txt")
          const release = Promise.withResolvers<void>()
          const held = Promise.withResolvers<void>()
          const fileReady = Promise.withResolvers<void>()
          const injected = Promise.withResolvers<void>()
          let childHits = 0
          let resultHits = 0
          const a = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("start a slow job")
          const b = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("extend the slow job")
          const childA = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("write the first background file")) return false
            childHits++
            if (childHits === 2) {
              held.resolve()
              fileReady.resolve()
            }
            return true
          }
          const childB = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("write the extension file")
          const result = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("Background task completed")) return false
            resultHits++
            if (resultHits === 1) injected.resolve()
            return true
          }
          reset(first)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const drain = yield* SessionDrain.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(a, "task", {
            description: "slow background write",
            prompt: "write the first background file",
            subagent_type: "general",
            background: true,
          })
          yield* llm.pushMatch(a, reply().wait(fileReady.promise).text("background task launched").stop())
          yield* llm.pushMatch(childA, reply().tool("write", { filePath: first, content: "first" }))
          yield* llm.pushMatch(childA, reply().text("first complete").wait(release.promise).stop())
          const firstTurn = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* prompt.prompt({
                sessionID: parent.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "start a slow job" }],
              })
              return yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
            }),
          )
          yield* Effect.promise(() => held.promise)
          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          const firstResponse = yield* Fiber.join(firstTurn)
          expect(firstResponse.info.role).toBe("assistant")
          expect(events).toHaveLength(2)
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)

          yield* llm.toolMatch(b, "task", {
            description: "extend background write",
            prompt: "write the extension file",
            subagent_type: "general",
            task_id: child.id,
          })
          yield* llm.textMatch(b, "extension queued")
          yield* llm.pushMatch(childB, reply().tool("write", { filePath: second, content: "second" }))
          yield* llm.pushMatch(childB, reply().text("extension complete").stop())
          yield* llm.pushMatch(result, reply().text("first background result").stop())
          yield* llm.pushMatch(result, reply().text("extended background result").stop())
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "extend the slow job" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          expect(events).toHaveLength(4)
          expect(events.slice(2).map((event) => event.sessionID)).toEqual([parent.id, parent.id])

          release.resolve()
          yield* Effect.promise(() => injected.promise)
          yield* drain.wait(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("completed")
          expect(resultHits).toBe(1)
          expect(events).toHaveLength(5)
          expect(events.every((event) => event.sessionID === parent.id)).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(parent.id)).flatMap((item) => item.parts)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-start" }> =>
                  part.type === "step-start" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot),
          ).toEqual([events[0]?.hash, events[2]?.hash])
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot)
              .sort(),
          ).toEqual([events[1]?.hash, events[3]?.hash, events[4]?.hash].sort())
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
        }),
        { git: true, config },
      ),
    { timeout: 90_000 },
  )

  background.live(
    "keeps a promoted task running until settlement before its final capture",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "promoted.txt")
          const release = Promise.withResolvers<void>()
          const held = Promise.withResolvers<void>()
          const fileReady = Promise.withResolvers<void>()
          const injected = Promise.withResolvers<void>()
          let childHits = 0
          const parentPrompt = (hit: { body: Record<string, unknown> }) =>
            JSON.stringify(hit.body).includes("promote a slow child")
          const childPrompt = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("write before promotion")) return false
            childHits++
            if (childHits === 2) {
              held.resolve()
              fileReady.resolve()
            }
            return true
          }
          const resultPrompt = (hit: { body: Record<string, unknown> }) => {
            if (!JSON.stringify(hit.body).includes("Background task completed")) return false
            injected.resolve()
            return true
          }
          reset(file)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const drain = yield* SessionDrain.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.toolMatch(parentPrompt, "task", {
            description: "foreground task to promote",
            prompt: "write before promotion",
            subagent_type: "general",
          })
          yield* llm.pushMatch(parentPrompt, reply().wait(fileReady.promise).text("task promoted").stop())
          yield* llm.pushMatch(childPrompt, reply().tool("write", { filePath: file, content: "written" }))
          yield* llm.pushMatch(childPrompt, reply().text("child complete").wait(release.promise).stop())
          const turn = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* prompt.prompt({
                sessionID: parent.id,
                agent: "build",
                noReply: true,
                parts: [{ type: "text", text: "promote a slow child" }],
              })
              return yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
            }),
          )

          yield* Effect.promise(() => held.promise)
          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* llm.pushMatch(resultPrompt, reply().text("promoted result received").stop())
          yield* jobs.promote(child.id)
          expect((yield* jobs.get(child.id))?.metadata?.background).toBe(true)
          yield* Fiber.join(turn)
          expect(events).toHaveLength(2)
          expect(events[0]?.exists).toBe(false)
          expect(events[1]?.exists).toBe(true)

          release.resolve()
          yield* Effect.promise(() => injected.promise)
          yield* drain.wait(parent.id)
          expect((yield* jobs.get(child.id))?.status).toBe("completed")
          expect(events).toHaveLength(3)
          expect(events.every((event) => event.sessionID === parent.id)).toBe(true)
          const parts = (yield* MessageV2.filterCompactedEffect(parent.id)).flatMap((item) => item.parts)
          expect(parts.filter((part) => part.type === "step-start" && part.snapshot)).toHaveLength(1)
          expect(
            parts
              .filter(
                (part): part is Extract<typeof part, { type: "step-finish" }> =>
                  part.type === "step-finish" && Boolean(part.snapshot),
              )
              .map((part) => part.snapshot)
              .sort(),
          ).toEqual([events[1]?.hash, events[2]?.hash].sort())
        }),
        { git: true, config },
      ),
    { timeout: 90_000 },
  )
})
