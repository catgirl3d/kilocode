// fork_change - new file
import { getGitCommitContent, searchGitCommits } from "../services/git/commits"

type Search = {
  requestId: string
  dir: string
  query: string
  post: (message: unknown) => void
}

export async function captureGitCommits(input: Search): Promise<void> {
  const commits = await searchGitCommits(input.query, input.dir)
  input.post({ type: "gitCommitsResult", requestId: input.requestId, commits })
}

type Context = {
  requestId: string
  dir: string
  hash: string
  post: (message: unknown) => void
  error: (error: unknown) => string
}

export async function captureGitCommitContext(input: Context): Promise<void> {
  try {
    const content = await getGitCommitContent(input.hash, input.dir)
    input.post({ type: "gitCommitContextResult", requestId: input.requestId, hash: input.hash, content })
  } catch (error) {
    console.error("[Kilo New] Failed to read git commit:", error)
    input.post({
      type: "gitCommitContextError",
      requestId: input.requestId,
      hash: input.hash,
      error: input.error(error) || "Failed to read git commit",
    })
  }
}
