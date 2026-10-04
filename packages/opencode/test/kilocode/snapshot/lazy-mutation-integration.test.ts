import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Session } from "../../../src/session/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { MessageV2 } from "../../../src/session/message-v2"
import { provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { config, events, layer, recording, reset } from "./fixture"

const it = testEffect(layer(recording))

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

  it.live(
    "keeps independent snapshot pairs for read->write and two writes",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const readable = path.join(dir, "readable.txt")
          yield* Effect.promise(() => fs.writeFile(readable, "readable"))
          reset()
          const first = path.join(dir, "first.txt")
          const second = path.join(dir, "second.txt")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("read", { filePath: readable })
          yield* llm.tool("write", { filePath: first, content: "one" })
          yield* llm.tool("write", { filePath: second, content: "two" })
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "read then write twice" }],
          })
          yield* prompt.loop({ sessionID: session.id, snapshotInitialization: "wait" })
          expect(events).toHaveLength(4)
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
          expect(finishes.map((part) => part.snapshot)).toEqual([events[1]?.hash, events[3]?.hash])
        }),
        { git: true, config },
      ),
    { timeout: 30_000 },
  )
})
