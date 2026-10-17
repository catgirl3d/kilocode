import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "node:path"
import { collect } from "@/kilocode/session/files"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_files_test")
const messageID = MessageID.make("msg_files_test")
const root = path.join(path.parse(process.cwd()).root, "kilo-session-files")

function absolute(file: string) {
  return path.join(root, file).replaceAll("\\", "/")
}

function patch(id: string, files: string[]): SessionV1.PatchPart {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID,
    type: "patch",
    hash: `hash_${id}`,
    files,
  }
}

function message(...parts: SessionV1.Part[]) {
  return { parts }
}

describe("session changed files collector", () => {
  test("returns sorted unique paths relative to the session directory", () => {
    const native = path.join(root, "src", "native.ts")

    expect(
      collect(
        [
          message(patch("one", [absolute("src/z.ts"), native, native])),
          message(patch("two", [absolute("src/z.ts"), absolute("docs/readme.md")])),
        ],
        root,
      ),
    ).toEqual(["docs/readme.md", "src/native.ts", "src/z.ts"])
  })

  test("skips absolute files outside the session directory", () => {
    expect(
      collect(
        [
          message(
            patch("outside", [
              absolute("src/inside.ts"),
              absolute("../outside.ts"),
              absolute("../kilo-session-files-old/file.ts"),
            ]),
          ),
        ],
        root,
      ),
    ).toEqual(["src/inside.ts"])
  })

  test("returns an empty list when no patch part has files", () => {
    expect(collect([message()], root)).toEqual([])
  })
})
