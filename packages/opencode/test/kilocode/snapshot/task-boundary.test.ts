import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Session } from "../../../src/session/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionRevert } from "../../../src/session/revert"
import { MessageV2 } from "../../../src/session/message-v2"
import { Snapshot } from "../../../src/snapshot"
import { provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { config, layer } from "./fixture"

const it = testEffect(layer())

const parentParts = (id: string, messages: MessageV2.WithParts[]) =>
  messages.filter((item) => item.info.role === "assistant" && item.info.sessionID === id).flatMap((item) => item.parts)

describe("foreground task snapshot boundary", () => {
  it.live(
    "protects the parent around real child work and restores it through public revert",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "child.txt")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const snapshot = yield* Snapshot.Service
          const revert = yield* SessionRevert.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("task", {
            description: "write child file",
            prompt: "write the requested file",
            subagent_type: "general",
          })
          yield* llm.tool("write", { filePath: file, content: "from child" })
          yield* llm.text("child done")
          yield* llm.text("parent done")
          const parentUser = yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "delegate the file write" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("from child")

          const parts = parentParts(parent.id, yield* MessageV2.filterCompactedEffect(parent.id))
          const start = parts.find((part) => part.type === "step-start" && part.snapshot)
          const finish = parts.find((part) => part.type === "step-finish" && part.snapshot)
          expect(start?.type).toBe("step-start")
          expect(finish?.type).toBe("step-finish")
          if (start?.type !== "step-start" || finish?.type !== "step-finish" || !start.snapshot) return

          const patch = yield* snapshot.patch(start.snapshot)
          expect(patch.files.some((item) => item.endsWith("child.txt"))).toBe(true)
          const outcome = yield* revert.revert({ sessionID: parent.id, messageID: parentUser.info.id })
          expect(outcome.revert?.workspace).toBe("restored")
          expect(
            yield* Effect.promise(() =>
              fs
                .access(file)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )

  it.live(
    "keeps task_id resume as a separate parent snapshot boundary",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const first = path.join(dir, "first-child.txt")
          const second = path.join(dir, "second-child.txt")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("task", { description: "write first", prompt: "write first", subagent_type: "general" })
          yield* llm.tool("write", { filePath: first, content: "first" })
          yield* llm.text("child one")
          yield* llm.text("parent one")
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run child" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
          const child = (yield* sessions.children(parent.id))[0]
          expect(child).toBeDefined()
          if (!child) return

          const firstParts = parentParts(parent.id, yield* MessageV2.filterCompactedEffect(parent.id))
          const firstStart = firstParts.find((part) => part.type === "step-start" && part.snapshot)
          const firstFinish = firstParts.find((part) => part.type === "step-finish" && part.snapshot)
          expect(firstStart?.type).toBe("step-start")
          expect(firstFinish?.type).toBe("step-finish")
          if (
            firstStart?.type !== "step-start" ||
            firstFinish?.type !== "step-finish" ||
            !firstStart.snapshot ||
            !firstFinish.snapshot
          )
            return

          yield* llm.tool("task", {
            description: "write second",
            prompt: "write second",
            subagent_type: "general",
            task_id: child.id,
          })
          yield* llm.tool("write", { filePath: second, content: "second" })
          yield* llm.text("child two")
          yield* llm.text("parent two")
          yield* prompt.prompt({
            sessionID: parent.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "resume child" }],
          })
          yield* prompt.loop({ sessionID: parent.id, snapshotInitialization: "wait" })
          const parts = parentParts(parent.id, yield* MessageV2.filterCompactedEffect(parent.id))
          const starts = parts.filter(
            (part): part is Extract<typeof part, { type: "step-start" }> =>
              part.type === "step-start" && Boolean(part.snapshot),
          )
          const finishes = parts.filter(
            (part): part is Extract<typeof part, { type: "step-finish" }> =>
              part.type === "step-finish" && Boolean(part.snapshot),
          )
          expect(starts).toHaveLength(2)
          expect(finishes).toHaveLength(2)
          expect(new Set(starts.map((part) => part.snapshot))).toHaveLength(2)
          expect(new Set(finishes.map((part) => part.snapshot))).toHaveLength(2)
          expect(yield* Effect.promise(() => fs.readFile(first, "utf8"))).toBe("first")
          expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second")
        }),
        { git: true, config },
      ),
    { timeout: 90_000 },
  )
})
