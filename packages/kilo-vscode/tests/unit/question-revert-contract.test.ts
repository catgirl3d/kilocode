/**
 * QuestionRevert wiring contract tests.
 *
 * Static analysis — reads AssistantMessage source and locks the guard that
 * decides when the "Revert to here" button renders under an answered question.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const FILE = path.join(ROOT, "webview-ui/src/components/chat/AssistantMessage.tsx")
const RENDER = "<QuestionRevert messageID={props.message.id} partID={part.id} />"

describe("AssistantMessage question revert contract", () => {
  const source = fs.readFileSync(FILE, "utf-8")
  const at = source.indexOf(RENDER)

  it("imports QuestionRevert and revertible from ./QuestionRevert", () => {
    expect(source).toMatch(/import \{[^}]*\bQuestionRevert\b[^}]*\brevertible\b[^}]*\} from "\.\/QuestionRevert"/)
  })

  it("renders QuestionRevert for the message and the answered part", () => {
    expect(at).toBeGreaterThan(-1)
  })

  it("guards the render with readonly, interactive prompt, current session and revertible checks", () => {
    expect(at).toBeGreaterThan(-1)
    const guard = source.slice(source.lastIndexOf("<Show", at), at)
    expect(guard).toContain("!props.readonly")
    expect(guard).toContain("props.interactivePrompts !== false")
    expect(guard).toContain("props.message.sessionID === session.currentSessionID()")
    expect(guard).toContain("revertible(part)")
  })
})
