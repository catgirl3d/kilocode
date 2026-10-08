import { describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const { KiloProvider } = await import("../../src/KiloProvider")

type Message = Record<string, unknown>
type Webview = {
  onDidReceiveMessage: (listener: (message: Message) => Promise<void>) => { dispose: () => void }
  postMessage: (message: unknown) => Promise<boolean>
}

type ProviderInternals = {
  webview: Webview | null
  setupWebviewMessageHandler: (webview: Webview) => void
}

function git(dir: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return Buffer.from(result.stdout).toString("utf8").trim()
  throw new Error(Buffer.from(result.stderr).toString("utf8") || Buffer.from(result.stdout).toString("utf8"))
}

async function createRepo(dir: string, subject: string): Promise<string> {
  git(dir, ["init"])
  git(dir, ["config", "core.autocrlf", "false"])
  git(dir, ["config", "user.name", "Kilo"])
  git(dir, ["config", "user.email", "kilo@example.com"])
  await fs.writeFile(path.join(dir, "commit.txt"), `${subject}\n`)
  git(dir, ["add", "commit.txt"])
  git(dir, ["commit", "-m", subject])
  return git(dir, ["rev-parse", "HEAD"])
}

function route(provider: KiloProvider, posted: unknown[]) {
  let receive: ((message: Message) => Promise<void>) | undefined
  const webview: Webview = {
    onDidReceiveMessage: (listener) => {
      receive = listener
      return { dispose: () => undefined }
    },
    postMessage: async (message) => {
      posted.push(message)
      return true
    },
  }
  const internal = provider as unknown as ProviderInternals
  internal.webview = webview
  internal.setupWebviewMessageHandler(webview)
  return async (message: Message) => {
    if (!receive) throw new Error("Expected a webview message route")
    await receive(message)
  }
}

describe("Git commits worktree routing", () => {
  it("searches the registered worktree and falls back to the root after clearing it", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-git-commits-root-"))
    try {
      const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-git-commits-worktree-"))
      try {
        const rootHash = await createRepo(rootDir, "root workspace commit")
        const worktreeHash = await createRepo(worktreeDir, "worktree unique commit")
        expect(rootHash).not.toBe(worktreeHash)

        const connection = {
          onSessionAcknowledged: () => () => undefined,
          unregisterVisible: () => undefined,
          unregisterAttached: () => undefined,
        } as unknown as ConstructorParameters<typeof KiloProvider>[1]
        const provider = new KiloProvider({} as never, connection, undefined, { rootDirectory: () => rootDir })
        try {
          const posted: unknown[] = []
          const send = route(provider, posted)
          const request = { type: "requestGitCommits", requestId: "route-worktree", query: "worktree unique" }
          provider.setSessionDirectory("ses-worktree-route", worktreeDir)

          await send({ ...request, sessionID: "ses-worktree-route" })
          expect(posted).toHaveLength(1)
          expect(posted[0]).toMatchObject({
            type: "gitCommitsResult",
            requestId: "route-worktree",
            commits: [{ hash: worktreeHash, subject: "worktree unique commit" }],
          })

          posted.length = 0
          await send(request)
          expect(posted).toHaveLength(1)
          expect(posted[0]).toMatchObject({
            type: "gitCommitsResult",
            requestId: "route-worktree",
            commits: [],
          })

          posted.length = 0
          provider.clearSessionDirectory("ses-worktree-route")
          await send({ ...request, sessionID: "ses-worktree-route" })
          expect(posted).toHaveLength(1)
          expect(posted[0]).toMatchObject({
            type: "gitCommitsResult",
            requestId: "route-worktree",
            commits: [],
          })
        } finally {
          provider.dispose()
        }
      } finally {
        await fs.rm(worktreeDir, { recursive: true, force: true })
      }
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true })
    }
  })
})
