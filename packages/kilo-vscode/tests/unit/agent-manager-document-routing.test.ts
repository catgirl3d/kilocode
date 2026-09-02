import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WorktreeDiffController } from "../../src/agent-manager/worktree-diff-controller"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import type { AgentManagerDocumentMessage } from "../../src/agent-manager/types"
import type { AgentManagerRequestDocumentMessage } from "../../webview-ui/src/types/messages"

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kilo-document-routing-"))
}

async function wait() {
  await Bun.sleep(0)
}

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (fs.existsSync(file)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function controller(
  root: string,
  state: WorktreeStateManager,
  sent: AgentManagerDocumentMessage[],
  getStateReady: () => Promise<void> | undefined = () => undefined,
) {
  return new WorktreeDiffController({
    getState: () => state,
    getRoot: () => root,
    getStateReady,
    catalog: {} as never,
    git: {} as never,
    localDiffFile: async () => null,
    post: (message) => {
      if (message.type === "agentManager.document") sent.push(message)
    },
    log: () => undefined,
  })
}

describe("Agent Manager document routing", () => {
  it("routes a document request to the session worktree and emits its content", async () => {
    const root = workspace()
    try {
      const worktree = path.join(root, "worktree")
      fs.mkdirSync(worktree)
      fs.writeFileSync(path.join(worktree, "plan.md"), "# Worktree plan\n")
      const state = new WorktreeStateManager(root, () => undefined)
      const item = state.addWorktree({ branch: "feature", path: worktree, parentBranch: "main" })
      state.addSession("ses-plan", item.id)
      const sent: AgentManagerDocumentMessage[] = []
      const ctl = controller(root, state, sent)
      const message = {
        type: "agentManager.requestDocument",
        sessionId: "ses-plan",
        file: "plan.md",
        contextKey: "project-a:feature",
      } satisfies AgentManagerRequestDocumentMessage

      ctl.document(message.sessionId, message.file, message.contextKey)
      await wait()

      expect(sent).toEqual([
        {
          type: "agentManager.document",
          sessionId: "ses-plan",
          contextKey: "project-a:feature",
          file: "plan.md",
          requestedFile: "plan.md",
          kind: "text",
          content: "# Worktree plan\n",
        },
      ])
    } finally {
      try {
        await waitForFile(path.join(root, ".kilo", "agent-manager.json"))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it("emits an error when a document request targets a stale session", async () => {
    const root = workspace()
    try {
      const state = new WorktreeStateManager(root, () => undefined)
      const sent: AgentManagerDocumentMessage[] = []
      const ctl = controller(root, state, sent)

      ctl.document("ses-stale", "plan.md", "project-a:removed")
      await wait()

      expect(sent).toEqual([
        {
          type: "agentManager.document",
          sessionId: "ses-stale",
          contextKey: "project-a:removed",
          file: "plan.md",
          requestedFile: "plan.md",
          error: "The document context is no longer available.",
        },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("delays document resolution until state readiness resolves", async () => {
    const root = workspace()
    try {
      const worktree = path.join(root, "worktree")
      fs.mkdirSync(worktree)
      fs.writeFileSync(path.join(worktree, "plan.md"), "# Worktree plan\n")
      const state = new WorktreeStateManager(root, () => undefined)
      const item = state.addWorktree({ branch: "feature", path: worktree, parentBranch: "main" })
      state.addSession("ses-plan", item.id)
      const sent: AgentManagerDocumentMessage[] = []
      let release: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        release = resolve
      })
      const ctl = controller(root, state, sent, () => ready)
      ctl.document("ses-plan", "plan.md", "project-a:feature")
      await wait()
      await wait()

      expect(sent).toEqual([])

      release()
      await ready
      await wait()

      expect(sent).toEqual([
        {
          type: "agentManager.document",
          sessionId: "ses-plan",
          contextKey: "project-a:feature",
          file: "plan.md",
          requestedFile: "plan.md",
          kind: "text",
          content: "# Worktree plan\n",
        },
      ])
    } finally {
      try {
        await waitForFile(path.join(root, ".kilo", "agent-manager.json"))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it("continues document resolution when state readiness rejects", async () => {
    const root = workspace()
    try {
      const state = new WorktreeStateManager(root, () => undefined)
      const sent: AgentManagerDocumentMessage[] = []
      const ctl = controller(root, state, sent, () => Promise.reject(new Error("state init failed")))

      ctl.document("ses-stale", "plan.md", "project-a:removed")
      await wait()

      expect(sent).toEqual([
        {
          type: "agentManager.document",
          sessionId: "ses-stale",
          contextKey: "project-a:removed",
          file: "plan.md",
          requestedFile: "plan.md",
          error: "The document context is no longer available.",
        },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
