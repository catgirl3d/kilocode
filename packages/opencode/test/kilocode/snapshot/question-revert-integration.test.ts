import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { MCP } from "../../../src/mcp"
import { LSP } from "../../../src/lsp/lsp"
import { Question } from "../../../src/question"
import { Session } from "../../../src/session/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionRevert } from "../../../src/session/revert"
import { SessionSummary } from "../../../src/session/summary"
import { Snapshot } from "../../../src/snapshot"
import { SessionID } from "../../../src/session/schema"
import { provideTmpdirServer } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
import { config, lsp, mcp } from "./fixture"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      SessionRevert.node,
      SessionSummary.node,
      Snapshot.node,
      Question.node,
      Database.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [MCP.node, mcp],
      [LSP.node, lsp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

const pending = (question: Question.Interface, sessionID: SessionID) =>
  pollWithTimeout(
    question.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === sessionID))),
    "question never became pending",
    "10 seconds",
  )

const questions = [
  {
    question: "Pick",
    header: "Pick",
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  },
]

describe("question revert integration", () => {
  it.live(
    "reverts files written after an answered question to the question checkpoint",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const file = path.join(dir, "a.txt")
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const question = yield* Question.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
          yield* llm.tool("write", { filePath: file, content: "one" })
          yield* llm.tool("question", { questions })
          yield* llm.tool("write", { filePath: file, content: "two" })
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "write, ask, then write again" }],
          })

          const loop = yield* prompt
            .loop({ sessionID: session.id, snapshotInitialization: "wait" })
            .pipe(Effect.forkScoped)
          const item = yield* pending(question, session.id)
          yield* question.reply({ requestID: item.id, answers: [["A"]] })
          yield* Fiber.join(loop)

          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("two")
          const messages = yield* sessions.messages({ sessionID: session.id })
          const asked = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && part.tool === "question")
          if (asked?.type !== "tool" || asked.state.status !== "completed") throw new Error("question did not complete")
          expect(asked.state.metadata?.checkpoint).toEqual(expect.any(String))
          const siblings = messages.find((message) => message.info.id === asked.messageID)?.parts ?? []
          const next = siblings.at(siblings.findIndex((part) => part.id === asked.id) + 1)
          if (next?.type !== "step-finish") throw new Error("expected the step to finish after the question")

          const result = yield* revert.revert({ sessionID: session.id, messageID: asked.messageID, partID: asked.id })
          expect(result.revert?.messageID).toBe(asked.messageID)
          expect(result.revert?.partID).toBe(next.id)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("one")

          yield* revert.unrevert({ sessionID: session.id })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("two")
        }),
        { git: true, config },
      ),
    { timeout: 60_000 },
  )
})
