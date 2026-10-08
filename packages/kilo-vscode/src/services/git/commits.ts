// fork_change - new file
import { run, type Result } from "./context"

const SMALL = 80_000
const LIMIT = 400_000
const FORMAT = "--format=%H%n%h%n%s%n%an%n%ad"

type GitCommitSearchItem = {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
}

/** Search commit messages, with the legacy hash lookup fallback. */
export async function searchGitCommits(query: string, dir: string): Promise<GitCommitSearchItem[]> {
  const probe = await run(["rev-parse", "--is-inside-work-tree"], dir, SMALL)
  if (probe.error || probe.code !== 0 || probe.out.trim() !== "true") return []

  const base = ["log", "-n", "10", "--date=short", FORMAT]
  const grep = await run([...base, "--regexp-ignore-case", `--grep=${query}`], dir, SMALL)
  if (grep.error) return []

  const fallback =
    !grep.out.trim() && /^[a-f0-9]+$/i.test(query)
      ? await run([...base, "--author-date-order", query], dir, SMALL)
      : undefined
  return parseCommits(fallback?.out.trim() ? fallback.out : grep.out)
}

function parseCommits(output: string): GitCommitSearchItem[] {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== "--")
  const commits: GitCommitSearchItem[] = []
  for (let index = 0; index + 4 < lines.length; index += 5) {
    commits.push({
      hash: lines[index]!,
      shortHash: lines[index + 1]!,
      subject: lines[index + 2]!,
      author: lines[index + 3]!,
      date: lines[index + 4]!,
    })
  }
  return commits
}

function check(result: Result, hash: string) {
  if (result.error) throw new Error(result.error)
  if (result.code !== 0 && !result.truncated) throw new Error(result.err.trim() || `Failed to read commit ${hash}`)
}

/** Return bounded legacy-style commit metadata, stats and patch for an @hash. */
export async function getGitCommitContent(hash: string, dir: string): Promise<string> {
  if (!/^[a-f0-9]{7,40}$/i.test(hash)) throw new Error("Invalid commit hash")

  const type = await run(["cat-file", "-t", hash], dir, SMALL)
  check(type, hash)
  if (type.out.trim() !== "commit") throw new Error("Git object is not a commit")

  const info = await run(["show", "--format=%H%n%h%n%s%n%an%n%ad%n%b", "--date=short", "--no-patch", hash], dir, SMALL)
  check(info, hash)

  const [full, short, subject, author, date, ...rest] = info.out.trim().split(/\r?\n/)
  const body = rest.join("\n").trim()
  const stats = await run(["show", "--stat", "--format=", hash], dir, SMALL)
  check(stats, hash)

  const diff = await run(["show", "--format=", hash], dir, LIMIT)
  check(diff, hash)

  const summary = [
    `Commit: ${short} (${full})`,
    `Author: ${author}`,
    `Date: ${date}`,
    `\nMessage: ${subject}`,
    body ? `\nDescription:\n${body}` : "",
    "\nFiles Changed:",
    stats.out.trim(),
    "\nFull Changes:",
  ].join("\n")
  const truncated = info.truncated || stats.truncated || diff.truncated
  return cap(`${summary}\n\n${diff.out.trim()}`, truncated)
}

/** Bound the assembled commit text as a whole, not just each git command. */
function cap(content: string, truncated: boolean): string {
  if (!truncated && Buffer.byteLength(content, "utf8") <= LIMIT) return content
  const text = Buffer.from(content, "utf8").subarray(0, LIMIT).toString("utf8")
  return `${text}\n\nOutput truncated.`
}
