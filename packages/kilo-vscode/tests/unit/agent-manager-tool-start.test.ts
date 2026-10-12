import { afterEach, describe, expect, it, mock } from "bun:test"
import { parseToolRequest, startFromTool, type ToolDeps, type ToolRequest } from "../../src/agent-manager/tool-start"
import type { CreateWorktreeResult } from "../../src/agent-manager/WorktreeManager"
import type { Session } from "@kilocode/sdk/v2/client"
import { handleToolEvent } from "../../src/agent-manager/tool-project"
import { normalize } from "../../src/services/cli-backend/sdk-sse-adapter"

const platform = Object.getOwnPropertyDescriptor(process, "platform")

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform)
})

function session(id: string): Session {
  return { id, title: id, createdAt: "", updatedAt: "" } as Session
}

function result(path: string): CreateWorktreeResult {
  return { path, branch: "kilo/test", parentBranch: "main", startPointSource: "fallback" } as CreateWorktreeResult
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const calls: unknown[] = []
  const panel = {
    waitForReady: mock(async () => calls.push("waitForReady")),
    sessions: { registerSession: mock(() => calls.push("registerSession")) },
  }
  return {
    getClient: () =>
      ({
        session: {
          create: mock(async () => ({ data: session("s-local") })),
          promptAsync: mock(async () => ({})),
        },
      }) as never,
    getRoot: () => "/repo",
    getState: () => ({ addSession: mock(() => calls.push("addSession")) }) as never,
    getWorktreeManager: () => undefined,
    autoName: () => ({ enabled: false, prefix: "" }),
    getPanel: () => panel as never,
    openPanel: mock(() => calls.push("openPanel")),
    waitReady: mock(async () => calls.push("waitReady")),
    createWorktree: mock(async () => ({ worktree: { id: "wt-1" }, result: result("/repo/.kilo/worktrees/wt-1") })),
    cleanupWorktree: mock(async () => calls.push("cleanupWorktree")),
    hasScript: () => true,
    setup: mock(async () => calls.push("setup")),
    createSessionInWorktree: mock(async () => session("s-wt")),
    sessionMetadata: mock(async () => ({ "kilocode.sandbox": { enabled: true, version: 0 } })),
    registerWorktreeSession: mock(() => calls.push("registerWorktreeSession")),
    notifyReady: mock(() => calls.push("notifyReady")),
    push: mock(() => calls.push("push")),
    post: mock((msg: unknown) => calls.push(msg)),
    capture: mock(() => calls.push("capture")),
    log: mock(() => {}),
    error: mock(() => {}),
    ...overrides,
  }
}

describe("agent manager tool start", () => {
  it.each([false, true])("gates the worktree prompt on setup script presence (%s)", async (script) => {
    const flow: string[] = []
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const prompted = Promise.withResolvers<void>()
    const client = {
      session: {
        promptAsync: async () => {
          flow.push("prompt")
          prompted.resolve()
          return {}
        },
      },
    }
    const host = deps({
      getClient: () => client as never,
      hasScript: () => script,
      sessionMetadata: async () => {
        flow.push("boot")
        return {}
      },
      setup: async (_dir, _branch, _id, early) => {
        flow.push("env")
        await early?.()
        entered.resolve()
        await gate.promise
        flow.push("setup:end")
      },
      createSessionInWorktree: async () => {
        flow.push("create")
        return session("s-wt")
      },
    })
    const pending = startFromTool(host, {
      requestID: "gate",
      mode: "worktree",
      tasks: [{ prompt: "Fix it" }],
    })
    await entered.promise
    if (!script) await prompted.promise
    expect(flow.includes("prompt")).toBe(!script)
    expect(flow.includes("boot")).toBe(!script)
    gate.resolve()
    await pending
    expect(flow).toEqual(
      script ? ["env", "setup:end", "boot", "create", "prompt"] : ["env", "boot", "create", "prompt", "setup:end"],
    )
  })

  for (const mode of ["local", "worktree"] as const) {
    for (const source of [undefined, "ses_source"]) {
      it(`attributes initial ${mode} prompts only with a source (${source ?? "ordinary"})`, async () => {
        const client = deps().getClient()
        const c = deps({ getClient: () => client })
        const req = parseToolRequest({
          requestID: `am-${mode}-${source}`,
          sessionID: source,
          mode,
          versions: true,
          tasks: [{ prompt: " First " }, { prompt: "Second" }, { name: "Prepared" }],
        })!
        await startFromTool(c, req)
        expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
        for (const text of ["First", "Second"]) {
          expect(client.session.promptAsync).toHaveBeenCalledWith(
            expect.objectContaining({
              parts: [
                { type: "text", text: source ? `${text}\n\n<!-- kilo-agent-manager source=${source} -->` : text },
              ],
            }),
            { throwOnError: true },
          )
        }
      })
    }
  }

  for (const mode of ["local", "worktree"] as const) {
    it(`preserves caller attribution through SSE and project routing for ${mode}`, async () => {
      const client = deps().getClient()
      const c = deps({ getClient: () => client })
      const done = Promise.withResolvers<void>()
      const owner = { id: "project" }
      handleToolEvent(
        normalize({
          type: "kilocode.agent_manager.start",
          properties: {
            requestID: `am-routed-${mode}`,
            sessionID: "ses_caller",
            mode,
            tasks: [{ prompt: "Initial delivery" }],
          },
        }),
        "/repo",
        { byDirectory: () => owner, usable: () => undefined },
        {
          run: async (project, fn) => {
            expect(project).toBe(owner)
            return fn()
          },
        },
        async (req) => {
          try {
            expect(req.projectId).toBe(owner.id)
            await startFromTool(c, req)
            done.resolve()
          } catch (err) {
            done.reject(err)
          }
        },
      )
      await done.promise
      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: [{ type: "text", text: "Initial delivery\n\n<!-- kilo-agent-manager source=ses_caller -->" }],
        }),
        { throwOnError: true },
      )
    })
  }
  it("parses explicit targets without changing null or omitted behavior", () => {
    const input = { mode: "local", tasks: [{ prompt: "Fix" }] }
    expect(parseToolRequest(input)?.worktreeID).toBeUndefined()
    expect(parseToolRequest({ ...input, worktreeID: null })?.worktreeID).toBeUndefined()
    expect(parseToolRequest({ ...input, worktreeID: "wt-target" })?.worktreeID).toBe("wt-target")
    for (const fields of [
      { worktreeID: "" },
      { worktreeID: " " },
      { worktreeID: 42 },
      { worktreeID: "wt-target", mode: "worktree" },
      { worktreeID: "wt-target", versions: true },
      { worktreeID: "wt-target", tasks: [{ prompt: "Fix", branchName: "" }] },
    ])
      expect(parseToolRequest({ ...input, ...fields })).toBeUndefined()
  })

  it("targets a non-caller worktree without creating or cleaning it", async () => {
    const wt = { id: "wt-target", path: "/repo/target" }
    const ready = { value: false }
    const state = {
      findWorktreeByPath: (dir: string) => (dir === "/repo/caller" ? { id: "wt-caller", path: dir } : undefined),
      getWorktree: mock((id: string) => {
        expect(ready.value).toBe(true)
        return id === wt.id ? wt : undefined
      }),
      addSession: mock(() => {}),
    }
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-target") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const c = deps({
      getClient: () => client as never,
      getState: () => state as never,
      waitReady: mock(async () => {
        ready.value = true
      }),
    })
    await startFromTool(c, {
      requestID: "am-target",
      mode: "local",
      directory: "/repo/caller",
      worktreeID: wt.id,
      sandboxInheritanceToken: "si-token",
      tasks: [{ prompt: "Fix", model: { providerID: "test", modelID: "model" }, variant: "high" }],
    })
    expect(c.sessionMetadata).toHaveBeenCalledWith(client, wt.path)
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ directory: wt.path, sandboxInheritanceToken: "si-token" }),
      { throwOnError: true },
    )
    expect(state.addSession).toHaveBeenCalledWith("s-target", wt.id)
    expect(c.registerWorktreeSession).toHaveBeenCalledWith("s-target", wt.path)
    expect(c.post).toHaveBeenCalledWith({
      type: "agentManager.sessionAdded",
      sessionId: "s-target",
      worktreeId: wt.id,
    })
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: wt.path,
        model: { providerID: "test", modelID: "model" },
        variant: "high",
      }),
      { throwOnError: true },
    )
    expect(c.createWorktree).not.toHaveBeenCalled()
    expect(c.setup).not.toHaveBeenCalled()
    expect(c.cleanupWorktree).not.toHaveBeenCalled()
    expect(c.error).not.toHaveBeenCalled()
  })

  it("rejects unknown or foreign IDs without falling back to the caller", async () => {
    const create = mock(async () => ({ data: session("s-local") }))
    const c = deps({
      getClient: () => ({ session: { create } }) as never,
      getState: () => ({ getWorktree: () => undefined }) as never,
    })
    await startFromTool(c, {
      requestID: "am-unknown",
      mode: "local",
      directory: "/repo",
      worktreeID: "wt-foreign",
      tasks: [{ name: "Prepared" }],
    })
    expect(create).not.toHaveBeenCalled()
    expect(c.createWorktree).not.toHaveBeenCalled()
    expect(c.cleanupWorktree).not.toHaveBeenCalled()
    expect(c.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: expect.stringContaining("wt-foreign") }),
    )
  })

  it("parses tool start events defensively", () => {
    const parsed = parseToolRequest({
      mode: "local",
      tasks: [
        {
          prompt: "one",
          model: { providerID: " test ", modelID: " reasoning/model " },
          variant: " high ",
        },
      ],
    })
    expect(parsed?.requestID.startsWith("am-")).toBe(true)
    expect(parsed?.sessionID).toBeUndefined()
    expect(parsed?.directory).toBeUndefined()
    expect(parsed?.mode).toBe("local")
    expect(parsed?.versions).toBeUndefined()
    expect(parsed?.tasks).toEqual([
      {
        prompt: "one",
        model: { providerID: "test", modelID: "reasoning/model" },
        variant: "high",
      },
    ])
    expect(
      parseToolRequest({
        mode: "local",
        tasks: [{ prompt: "one", model: { providerID: "", modelID: "model" }, variant: "high" }],
      }),
    ).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [{ prompt: "one", variant: "high" }] })).toBeUndefined()
    expect(
      parseToolRequest({
        mode: "local",
        tasks: [{ name: "Prepared session", model: { providerID: "test", modelID: "model" } }],
      }),
    ).toBeUndefined()
    expect(parseToolRequest({ mode: "bad", tasks: [{ prompt: "one" }] })).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [] })).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [{}] })).toBeUndefined()
  })

  it("starts local sessions and sends the initial prompt", async () => {
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-local") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const c = deps({ getClient: () => client as never })
    const req: ToolRequest = {
      requestID: "am-1",
      mode: "local",
      tasks: [
        {
          prompt: "Do work",
          model: { providerID: "test", modelID: "reasoning/model" },
          variant: "high",
        },
      ],
    }

    await startFromTool(c, req)

    expect(c.openPanel).toHaveBeenCalledWith(true)
    const panel = c.getPanel()
    expect(panel?.waitForReady).toHaveBeenCalled()
    expect(client.session.create).toHaveBeenCalledWith(
      {
        directory: "/repo",
        platform: "agent-manager",
        metadata: { "kilocode.sandbox": { enabled: true, version: 0 } },
      },
      { throwOnError: true },
    )
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s-local",
        directory: "/repo",
        parts: [{ type: "text", text: "Do work" }],
        model: { providerID: "test", modelID: "reasoning/model" },
        variant: "high",
        snapshotInitialization: "wait",
      }),
      { throwOnError: true },
    )
  })

  it("passes sandbox inheritance token to local sessions", async () => {
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-local") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const c = deps({ getClient: () => client as never })

    await startFromTool(c, {
      requestID: "am-local-source",
      sessionID: "s-parent",
      sandboxInheritanceToken: "si-token",
      mode: "local",
      tasks: [{ prompt: "Do work" }],
    })

    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxInheritanceToken: "si-token" }),
      { throwOnError: true },
    )
  })

  it("starts local sessions when Windows drive-letter casing differs", async () => {
    setPlatform("win32")
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-local") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const state = {
      addSession: mock(() => {}),
      findWorktreeByPath: mock(() => undefined),
    }
    const c = deps({
      getClient: () => client as never,
      getRoot: () => "c:\\Users\\dev\\repo",
      getState: () => state as never,
    })

    await startFromTool(c, {
      requestID: "am-windows-dir",
      mode: "local",
      directory: "C:\\Users\\dev\\repo",
      tasks: [{ prompt: "Do work" }],
    })

    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({ directory: "c:\\Users\\dev\\repo" }), {
      throwOnError: true,
    })
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "c:\\Users\\dev\\repo" }),
      { throwOnError: true },
    )
    expect(state.addSession).toHaveBeenCalledWith("s-local", null)
    expect(state.findWorktreeByPath).not.toHaveBeenCalled()
    expect(c.error).not.toHaveBeenCalled()
  })

  it("starts worktree sessions through existing hooks", async () => {
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-local") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const c = deps({ getClient: () => client as never })
    await startFromTool(c, {
      requestID: "am-2",
      sessionID: "s-parent",
      sandboxInheritanceToken: "si-token",
      mode: "worktree",
      tasks: [
        {
          prompt: "Fix",
          branchName: "fix/One_two.3",
          model: { providerID: "test", modelID: "reasoning/model" },
          variant: "low",
        },
      ],
    })

    expect(c.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "fix/One_two.3", name: "fix/One_two.3", label: "one two 3" }),
    )
    expect(c.setup).toHaveBeenCalled()
    expect(c.createSessionInWorktree).toHaveBeenCalledWith(
      "/repo/.kilo/worktrees/wt-1",
      "kilo/test",
      "wt-1",
      {
        sessionID: "s-parent",
        sandboxInheritanceToken: "si-token",
      },
      expect.any(Object),
      expect.any(Object),
    )
    expect(c.registerWorktreeSession).toHaveBeenCalledWith("s-wt", "/repo/.kilo/worktrees/wt-1")
    expect(c.notifyReady).toHaveBeenCalled()
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s-wt",
        directory: "/repo/.kilo/worktrees/wt-1",
        model: { providerID: "test", modelID: "reasoning/model" },
        variant: "low",
      }),
      { throwOnError: true },
    )
  })

  it("renames an agent-started worktree before sending its prompt", async () => {
    const flow: string[] = []
    const generated: unknown[] = []
    const row = {
      id: "wt-1",
      branch: "kilo/test",
      path: "/repo/.kilo/worktrees/wt-1",
      branchOwned: true,
    }
    const originalPath = row.path
    const state = {
      addSession: mock(() => flow.push("state")),
      renameOwnedWorktree: mock((_id: string, _current: string, branch: string, path: string) => {
        row.branch = branch
        row.path = path
        flow.push(`state-rename:${path}:${branch}`)
        return true
      }),
    }
    const manager = {
      renameWorktree: mock(async (_path: string, _current: string, requested: string) => ({
        branch: requested,
        path: "/repo/.kilo/worktrees/fix-agent-start",
      })),
    }
    const client = {
      session: {
        promptAsync: async (input: { directory: string }) => {
          flow.push(`prompt:${input.directory}`)
          return {}
        },
      },
      branchName: {
        generate: mock(async (input: unknown) => {
          flow.push("generate")
          generated.push(input)
          return { data: { branch: "Fix Agent Start" } }
        }),
      },
      experimental: {
        controlPlane: {
          moveSession: async () => {
            flow.push("move")
          },
        },
      },
    }
    const c = deps({
      getClient: () => client as never,
      getState: () => state as never,
      getWorktreeManager: () => manager as never,
      autoName: () => ({ enabled: true, prefix: "feat" }),
      createWorktree: async () => ({ worktree: row, result: result(row.path) }),
      createSessionInWorktree: async () => session("s-wt"),
      registerWorktreeSession: mock((_id: string, directory: string) => flow.push(`register:${directory}`)),
      notifyReady: mock((_id: string, created: CreateWorktreeResult) =>
        flow.push(`ready:${created.path}:${created.branch}`),
      ),
    })

    await startFromTool(c, {
      requestID: "am-named",
      mode: "worktree",
      tasks: [{ prompt: "Fix Agent Start", model: { providerID: "provider-tool", modelID: "model-tool" } }],
    })

    expect(generated).toEqual([
      {
        directory: originalPath,
        sessionID: "s-wt",
        prompt: "Fix Agent Start",
        providerID: "provider-tool",
        modelID: "model-tool",
      },
    ])
    expect(flow).toEqual([
      "state",
      "generate",
      "move",
      "state-rename:/repo/.kilo/worktrees/fix-agent-start:feat/fix-agent-start",
      "register:/repo/.kilo/worktrees/fix-agent-start",
      "ready:/repo/.kilo/worktrees/fix-agent-start:feat/fix-agent-start",
      "prompt:/repo/.kilo/worktrees/fix-agent-start",
    ])
    expect(manager.renameWorktree).toHaveBeenCalledWith(originalPath, "kilo/test", "feat/fix-agent-start")
    expect(flow.indexOf("register:/repo/.kilo/worktrees/fix-agent-start")).toBeLessThan(
      flow.indexOf("prompt:/repo/.kilo/worktrees/fix-agent-start"),
    )
  })

  it("cleans only the new session when naming fails after a partial rollback", async () => {
    const originalPath = "/repo/.kilo/worktrees/wt-1"
    const row = { id: "wt-1", branch: "kilo/test", path: originalPath, branchOwned: true }
    const setupDone = Promise.withResolvers<void>()
    const namingFailed = Promise.withResolvers<void>()
    const state = {
      addSession: mock(() => {}),
      removeSession: mock(() => {}),
      renameOwnedWorktree: mock(() => true),
    }
    const client = {
      session: {
        abort: mock(async (input: { sessionID: string; directory: string }) => {
          expect(input).toEqual({ sessionID: "s-wt", directory: originalPath })
          throw new Error("abort unavailable")
        }),
        delete: mock(async () => ({})),
        promptAsync: mock(async () => ({})),
      },
      backgroundProcess: { stopSession: mock(async () => ({})) },
      branchName: { generate: mock(async () => ({ data: { branch: "Fix Agent Start" } })) },
      experimental: {
        controlPlane: {
          moveSession: mock(async () => {
            throw new Error("move refused")
          }),
        },
      },
    }
    let renames = 0
    const manager = {
      renameWorktree: mock(async () => {
        renames++
        if (renames === 2) {
          namingFailed.resolve()
          throw new Error("rollback refused")
        }
        return { branch: "feat/fix-agent-start", path: "/repo/.kilo/worktrees/fix-agent-start" }
      }),
    }
    const aborts: string[][] = []
    const clear = mock(() => {})
    const panel = {
      waitForReady: mock(async () => {}),
      sessions: {
        registerSession: mock(() => {}),
        abortSessions: mock(async (ids: readonly string[]) => {
          aborts.push([...ids])
          throw new Error("abort unavailable")
        }),
        clearSessionDirectory: clear,
      },
    }
    const c = deps({
      getClient: () => client as never,
      getState: () => state as never,
      getPanel: () => panel as never,
      getWorktreeManager: () => manager as never,
      autoName: () => ({ enabled: true, prefix: "feat" }),
      createWorktree: async () => ({ worktree: row, result: result(originalPath) }),
      createSessionInWorktree: async () => session("s-wt"),
      hasScript: () => false,
      setup: async (_dir, _branch, _id, early) => {
        await early?.()
        await setupDone.promise
      },
    })

    const pending = startFromTool(c, {
      requestID: "am-naming-failure",
      mode: "worktree",
      tasks: [{ prompt: "Fix Agent Start" }],
    })

    await namingFailed.promise
    expect(aborts).toEqual([])
    setupDone.resolve()
    await pending

    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(c.notifyReady).not.toHaveBeenCalled()
    expect(c.registerWorktreeSession).not.toHaveBeenCalled()
    expect(c.cleanupWorktree).not.toHaveBeenCalled()
    expect(aborts).toEqual([])
    expect(client.session.abort).toHaveBeenCalledWith(
      { sessionID: "s-wt", directory: originalPath },
      { throwOnError: true },
    )
    expect(client.session.delete).toHaveBeenCalledWith(
      { sessionID: "s-wt", directory: originalPath },
      { throwOnError: true },
    )
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining("abort unavailable"))
    expect(state.removeSession).toHaveBeenCalledWith("s-wt")
    expect(clear).toHaveBeenCalledWith("s-wt")
    expect(c.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: expect.stringContaining("rollback refused") }),
    )
  })

  it.each([
    { label: "disabled", enabled: false, owned: true, task: { prompt: "Fix it" } },
    { label: "unowned", enabled: true, owned: false, task: { prompt: "Fix it" } },
    { label: "empty prompt", enabled: true, owned: true, task: { prompt: "   " } },
    { label: "no prompt", enabled: true, owned: true, task: {} },
    { label: "explicit name", enabled: true, owned: true, task: { prompt: "Fix it", name: "Prepared" } },
    { label: "explicit branch", enabled: true, owned: true, task: { prompt: "Fix it", branchName: "prepared" } },
    {
      label: "manager unavailable",
      enabled: true,
      owned: true,
      hasManager: false,
      task: { prompt: "Fix it" },
    },
  ])(
    "does not generate or reroute an ineligible $label worktree",
    async ({ label, enabled, owned, hasManager = true, task }) => {
      const originalPath = "/repo/.kilo/worktrees/original"
      const row = { id: "wt-1", branch: "kilo/test", path: originalPath, branchOwned: owned }
      const generated = mock(async () => ({ data: { branch: "Fix Generated Name" } }))
      const moved = mock(async () => undefined)
      const renamed = mock(async () => ({ branch: "feat/fix-generated-name", path: "/repo/.kilo/worktrees/renamed" }))
      const registered: string[] = []
      const prompted: string[] = []
      const state = {
        addSession: mock(() => {}),
        renameOwnedWorktree: mock(() => true),
      }
      const client = {
        session: {
          promptAsync: mock(async (input: { directory: string }) => {
            prompted.push(input.directory)
            return {}
          }),
        },
        branchName: { generate: generated },
        experimental: { controlPlane: { moveSession: moved } },
      }
      const c = deps({
        getClient: () => client as never,
        getState: () => state as never,
        getWorktreeManager: () => (hasManager ? ({ renameWorktree: renamed } as never) : undefined),
        autoName: () => ({ enabled, prefix: "feat" }),
        createWorktree: async () => ({ worktree: row, result: result(originalPath) }),
        registerWorktreeSession: mock((_id: string, directory: string) => registered.push(directory)),
      })

      await startFromTool(c, { requestID: `am-ineligible-${label}`, mode: "worktree", tasks: [task] })

      const prompt = "prompt" in task ? task.prompt : undefined
      expect(generated).not.toHaveBeenCalled()
      expect(renamed).not.toHaveBeenCalled()
      expect(moved).not.toHaveBeenCalled()
      expect(registered).toEqual([originalPath])
      expect(prompted).toEqual(prompt?.trim() ? [originalPath] : [])
      expect(row).toEqual({ id: "wt-1", branch: "kilo/test", path: originalPath, branchOwned: owned })
    },
  )

  it("deduplicates repeated delivery of the same exact request", async () => {
    const requests = new Set<string>()
    const c = deps({
      claimRequest: mock((id: string) => {
        if (requests.has(id)) return false
        requests.add(id)
        return true
      }),
    })
    const req: ToolRequest = {
      requestID: "am-duplicate",
      mode: "worktree",
      tasks: [
        {
          branchName: "echo-hello-world",
          name: "Echo hello world",
          prompt: 'Use the bash tool to run: echo "hello world". Report back the output.',
        },
      ],
    }

    await startFromTool(c, req)
    await startFromTool(c, req)

    expect(c.createWorktree).toHaveBeenCalledTimes(1)
    expect(c.createSessionInWorktree).toHaveBeenCalledTimes(1)
  })

  it("starts each task from separate tool calls even when their branch seeds match", async () => {
    const requests = new Set<string>()
    const c = deps({
      claimRequest: mock((id: string) => {
        if (requests.has(id)) return false
        requests.add(id)
        return true
      }),
    })
    const req: ToolRequest = {
      requestID: "am-first",
      mode: "worktree",
      tasks: [
        {
          branchName: "echo-hello-world",
          name: "Echo hello world",
          prompt: 'Use the bash tool to run: echo "hello world". Report back the output.',
        },
      ],
    }

    await startFromTool(c, req)
    await startFromTool(c, { ...req, requestID: "am-second" })

    expect(c.createWorktree).toHaveBeenCalledTimes(2)
    expect(c.createSessionInWorktree).toHaveBeenCalledTimes(2)
    expect(c.createWorktree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ branchName: "echo-hello-world", name: "echo-hello-world" }),
    )
  })

  it("deduplicates concurrent delivery of the same request", async () => {
    const requests = new Set<string>()
    const pending = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const c = deps({
      claimRequest: mock((id: string) => {
        if (requests.has(id)) return false
        requests.add(id)
        return true
      }),
      createWorktree: mock(async () => {
        pending.resolve()
        await resume.promise
        return { worktree: { id: "wt-1" }, result: result("/repo/.kilo/worktrees/wt-1") }
      }),
    })
    const req: ToolRequest = {
      requestID: "am-concurrent",
      mode: "worktree",
      tasks: [{ prompt: "Fix", branchName: "fix/concurrent" }],
    }

    const first = startFromTool(c, req)
    await pending.promise
    await startFromTool(c, req)
    resume.resolve()
    await first

    expect(c.createWorktree).toHaveBeenCalledTimes(1)
  })

  it("only applies version suffixes when versions is true", async () => {
    const normal = deps()
    await startFromTool(normal, {
      requestID: "am-normal",
      mode: "worktree",
      tasks: [
        { prompt: "Fix one", branchName: "fix/one" },
        { prompt: "Fix two", branchName: "fix/two" },
      ],
    })
    expect(normal.createWorktree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ branchName: "fix/two", label: "two" }),
    )

    const grouped = deps()
    await startFromTool(grouped, {
      requestID: "am-versions",
      mode: "worktree",
      versions: true,
      tasks: [
        { prompt: "Try one", branchName: "try/work" },
        { prompt: "Try two", branchName: "try/work" },
      ],
    })
    expect(grouped.createWorktree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ branchName: "try/work_v2", label: "try work v2" }),
    )
  })

  it("passes invalid explicit names to worktree validation and keeps card labels short", async () => {
    const c = deps()
    await startFromTool(c, {
      requestID: "am-name",
      mode: "worktree",
      tasks: [
        {
          prompt: "Fix command permissions persistence regression",
          name: "Fix command permissions persistence regression that is too long",
          branchName: "fix command permissions @#$ persistence",
        },
      ],
    })

    expect(c.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "fix command permissions @#$ persistence",
        label: "command permissions",
      }),
    )
  })

  it("still sanitizes display names used as automatic branch seeds", async () => {
    const c = deps()
    await startFromTool(c, {
      requestID: "am-seed",
      mode: "worktree",
      tasks: [{ name: "My Feature" }],
    })
    expect(c.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branchName: "my-feature" }))
  })

  it("rejects local sessions for unknown worktree directories", async () => {
    const client = {
      session: {
        create: mock(async () => ({ data: session("s-local") })),
        promptAsync: mock(async () => ({})),
      },
    }
    const c = deps({
      getClient: () => client as never,
      getState: () => ({ addSession: mock(), findWorktreeByPath: mock(() => undefined) }) as never,
    })

    await startFromTool(c, {
      requestID: "am-dir",
      mode: "local",
      directory: "/repo/other",
      tasks: [{ prompt: "Do work" }],
    })

    expect(client.session.create).not.toHaveBeenCalled()
    expect(c.error).toHaveBeenCalled()
  })
})
