import { describe, expect, it } from "bun:test"
import { buildGitChangesAttachment as git } from "../../webview-ui/src/hooks/git-changes-context-utils"
import { buildTerminalAttachment as terminal } from "../../webview-ui/src/hooks/terminal-context-utils"

describe.each([
  ["terminal", terminal, "terminal-output.txt"],
  ["git-changes", git, "git-changes.txt"],
])("%s context utils", (token, build, filename) => {
  const value = `@${token}`

  it("rejects missing mentions and false prefixes or suffixes", () => {
    for (const text of ["plain text", `foo${value}`, `${value}-output`, `${value}.`]) {
      expect(build(text, "content")).toBeUndefined()
    }
  })

  it("preserves whitespace boundaries, first spans, repeated calls and encoded content", () => {
    for (const prefix of ["", "hello ", "\r\n\t", "\u00a0"]) {
      const mention = { value, start: prefix.length, end: prefix.length + value.length }
      const expected = {
        mime: "text/plain",
        filename,
        url: "data:text/plain;charset=utf-8,%C3%A9%20%25%26%23%3F%0D%0A",
        source: { type: "file", path: filename, text: mention },
      }
      expect(build(`${prefix}${value} ${value}`, "é %&#?\r\n")).toEqual(expected)
      expect(build(`${prefix}${value}`, "é %&#?\r\n")).toEqual(expected)
    }
  })
})

it("builds source-associated attachments for full-hash commit mentions", async () => {
  const path = "../../webview-ui/src/hooks/git-commits-context-utils"
  const utils = await import(path).catch(() => undefined)
  expect(utils).toBeDefined()
  if (!utils) return

  const first = "a".repeat(40)
  const second = "b".repeat(40)
  const text = `Compare @${first} and @${second} now.`
  expect(utils.findCommitHashes(text)).toEqual([first, second])
  expect(
    utils.buildCommitAttachments(text, [
      { hash: first, content: "first commit" },
      { hash: second, content: "second commit" },
    ]),
  ).toEqual([
    {
      mime: "text/plain",
      url: "data:text/plain;charset=utf-8,first%20commit",
      filename: `git-commit-${first.slice(0, 7)}.txt`,
      source: {
        type: "file",
        path: `git-commit-${first.slice(0, 7)}.txt`,
        text: { value: `@${first}`, start: text.indexOf(`@${first}`), end: text.indexOf(`@${first}`) + 41 },
      },
    },
    {
      mime: "text/plain",
      url: "data:text/plain;charset=utf-8,second%20commit",
      filename: `git-commit-${second.slice(0, 7)}.txt`,
      source: {
        type: "file",
        path: `git-commit-${second.slice(0, 7)}.txt`,
        text: { value: `@${second}`, start: text.indexOf(`@${second}`), end: text.indexOf(`@${second}`) + 41 },
      },
    },
  ])
})

it("recognizes uppercase full-hash mentions and preserves their source text", async () => {
  const path = "../../webview-ui/src/hooks/git-commits-context-utils"
  const utils = await import(path).catch(() => undefined)
  expect(utils).toBeDefined()
  if (!utils) return

  const hash = "a".repeat(40)
  const token = `@${hash.toUpperCase()}`
  const text = `Review ${token} now.`
  const start = text.indexOf(token)
  const files = utils.buildCommitAttachments(text, [{ hash, content: "uppercase commit" }])

  expect(utils.findCommitHashes(text)).toEqual([hash])
  expect(files).toHaveLength(1)
  expect(files.at(0)?.source?.text).toEqual({ value: token, start, end: start + token.length })
})

it("deduplicates uppercase and lowercase mentions of the same hash", async () => {
  const path = "../../webview-ui/src/hooks/git-commits-context-utils"
  const utils = await import(path).catch(() => undefined)
  expect(utils).toBeDefined()
  if (!utils) return

  const hash = "b".repeat(40)
  expect(utils.findCommitHashes(`Compare @${hash.toUpperCase()} with @${hash}`)).toEqual([hash])
})

it("does not recognize abbreviated commit hashes", async () => {
  const path = "../../webview-ui/src/hooks/git-commits-context-utils"
  const utils = await import(path).catch(() => undefined)
  expect(utils).toBeDefined()
  if (!utils) return

  const hash = "c".repeat(40)
  for (const length of [7, 12]) {
    const text = `Review @${hash.slice(0, length)}`
    expect(utils.findCommitHashes(text)).toEqual([])
    expect(utils.hasCommitMentions(text)).toBe(false)
  }
})
