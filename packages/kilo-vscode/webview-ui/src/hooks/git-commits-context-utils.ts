// fork_change - new file
import type { FileAttachment } from "../types/messages"
import { attachment } from "./context-mention-utils"

type GitCommitMention = { hash: string; start: number; end: number }

const HASH = /^[a-f0-9]{40}$/i
const MENTION = /(^|\s)@([a-f0-9]{40})(?=\s|$)/gi

export function isCommitHash(value: string): boolean {
  return HASH.test(value)
}

export function findCommitMentions(text: string): GitCommitMention[] {
  MENTION.lastIndex = 0
  return [...text.matchAll(MENTION)].map((match) => {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    return { hash: match[2]!.toLowerCase(), start, end: start + 41 }
  })
}

export function findCommitHashes(text: string): string[] {
  return [...new Set(findCommitMentions(text).map((mention) => mention.hash))]
}

export function hasCommitMentions(text: string): boolean {
  return findCommitMentions(text).length > 0
}

/** Attach the resolved `git show` output at each exact full-hash mention span. */
export function buildCommitAttachments(
  text: string,
  commits: Array<{ hash: string; content: string }>,
): FileAttachment[] {
  const content = new Map(commits.map((commit) => [commit.hash.toLowerCase(), commit.content]))
  const names = new Map<string, number>()
  const result: FileAttachment[] = []

  for (const mention of findCommitMentions(text)) {
    const value = content.get(mention.hash)
    if (value === undefined) continue
    const count = names.get(mention.hash) ?? 0
    names.set(mention.hash, count + 1)
    const suffix = count ? `-${count + 1}` : ""
    const filename = `git-commit-${mention.hash.slice(0, 7)}${suffix}.txt`
    const token = { value: text.slice(mention.start, mention.end), start: mention.start, end: mention.end }
    const file = attachment(token, value, filename)
    if (file) result.push(file)
  }

  return result
}
