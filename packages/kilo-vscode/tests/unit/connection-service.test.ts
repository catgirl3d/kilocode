import { describe, expect, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

function state(value: boolean) {
  return {
    get: <T>() => value as T,
    update: async () => undefined,
  }
}

describe("KiloConnectionService sandbox preference", () => {
  test("uses workspace state instead of extension-global state", () => {
    const service = new KiloConnectionService({
      workspaceState: state(false),
      globalState: state(true),
    } as any)

    expect(service.sandboxPreference.resolve(true)).toBe(false)
  })
})

describe("KiloConnectionService visible sessions", () => {
  test("reports a session as visible while any surface displays it", () => {
    const service = new KiloConnectionService({} as any)

    expect(service.isVisible("ses-1")).toBe(false)

    service.registerVisible("sidebar", ["ses-1"])
    service.registerVisible("agent-manager", ["ses-2"])
    expect(service.isVisible("ses-1")).toBe(true)
    expect(service.isVisible("ses-2")).toBe(true)
    expect(service.isVisible("ses-3")).toBe(false)

    // A hidden panel registers an empty set, which is what makes this usable as
    // the notification suppression check.
    service.registerVisible("sidebar", [])
    expect(service.isVisible("ses-1")).toBe(false)
    expect(service.isVisible("ses-2")).toBe(true)

    service.unregisterVisible("agent-manager")
    expect(service.isVisible("ses-2")).toBe(false)
  })
})

describe("KiloConnectionService clients", () => {
  test("returns a connected client without a workspace folder", async () => {
    const service = new KiloConnectionService({} as any)
    const client = {}
    const workspace = vscode.workspace as { workspaceFolders?: readonly vscode.WorkspaceFolder[] }
    const folders = workspace.workspaceFolders

    ;(service as any).client = client
    ;(service as any).state = "connected"
    workspace.workspaceFolders = undefined

    try {
      expect(await service.getClientAsync()).toBe(client)
    } finally {
      workspace.workspaceFolders = folders
    }
  })
})

describe("KiloConnectionService explicit aborts", () => {
  const close = {
    id: "event-close",
    type: "session.turn.close",
    properties: { sessionID: "session", reason: "interrupted" },
  } as SSEPayload

  function setup() {
    const service = new KiloConnectionService({} as any)
    const raw: SSEPayload[] = []
    const first: SSEPayload[] = []
    const second: SSEPayload[] = []
    service.onEvent((event) => raw.push(event))
    service.onEventFiltered(
      () => true,
      (event) => first.push(event),
    )
    service.onEventFiltered(
      () => true,
      (event) => second.push(event),
    )
    return { service, raw, first, second }
  }

  test("suppresses a successful explicit abort for filtered subscribers", async () => {
    const state = setup()

    await state.service.runExplicitAbort("session", "/repo", async () => {
      ;(state.service as any).broadcast(close, "/repo")
    })

    expect(state.first).toEqual([])
    expect(state.second).toEqual([])
    expect(state.raw).toEqual([close])
  })

  test("replays a failed explicit abort for filtered subscribers", async () => {
    const state = setup()

    await expect(
      state.service.runExplicitAbort("session", "/repo", async () => {
        ;(state.service as any).broadcast(close, "/repo")
        throw new Error("abort failed")
      }),
    ).rejects.toThrow("abort failed")

    expect(state.first).toEqual([close])
    expect(state.second).toEqual([close])
    expect(state.raw).toEqual([close])
  })
})

describe("KiloConnectionService viewed sessions", () => {
  test("keeps Agent Manager sessions when sidebar visibility changes during a flush", async () => {
    const service = new KiloConnectionService({} as any)
    const calls: Array<{ viewer: { id: string; active: boolean }; attached: string[]; visible: string[] }> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let active = 0
    let max = 0

    ;(service as any).client = {
      session: {
        viewed: async (input: { viewer: { id: string; active: boolean }; attached: string[]; visible: string[] }) => {
          calls.push(input)
          active += 1
          max = Math.max(max, active)
          if (calls.length === 1) await gate
          active -= 1
        },
      },
    }

    service.registerVisible("agent-manager", ["am-1"])
    service.registerAttached("agent-manager", ["am-1", "am-2"])
    await Bun.sleep(175)
    expect(calls).toHaveLength(1)
    expect([...calls[0].visible].sort()).toEqual(["am-1"])
    expect([...calls[0].attached].sort()).toEqual(["am-1", "am-2"])

    service.registerVisible("sidebar", ["side-1"])
    await Bun.sleep(175)
    expect(calls).toHaveLength(1)

    release()
    await Bun.sleep(10)
    expect(max).toBe(1)
    expect([...calls[1].visible].sort()).toEqual(["am-1", "side-1"])
    expect([...calls[1].attached].sort()).toEqual(["am-1", "am-2", "side-1"])

    service.registerVisible("sidebar", [])
    await Bun.sleep(175)
    expect([...calls[2].visible].sort()).toEqual(["am-1"])
    expect([...calls[2].attached].sort()).toEqual(["am-1", "am-2"])
  })

  test("window focus gates viewer.active but not attachment", async () => {
    const window = vscode.window as unknown as {
      state: { focused: boolean }
      onDidChangeWindowState: (listener: (ws: { focused: boolean }) => void) => { dispose(): void }
    }
    const original = window.onDidChangeWindowState
    let listener: ((ws: { focused: boolean }) => void) | undefined
    window.onDidChangeWindowState = (cb) => {
      listener = cb
      return { dispose: () => {} }
    }

    try {
      const service = new KiloConnectionService({} as any)
      const calls: Array<{ viewer: { id: string; active: boolean }; attached: string[]; visible: string[] }> = []
      ;(service as any).client = {
        session: {
          viewed: async (input: (typeof calls)[number]) => {
            calls.push(input)
          },
        },
      }

      service.registerVisible("sidebar", ["ses-1"])
      service.registerAttached("sidebar", ["ses-1", "ses-2"])
      await Bun.sleep(175)
      expect(calls).toHaveLength(1)
      expect(calls[0].viewer.active).toBe(true)

      listener!({ focused: false })
      await Bun.sleep(175)
      expect(calls).toHaveLength(2)
      expect(calls[1].viewer.active).toBe(false)
      expect([...calls[1].visible].sort()).toEqual(["ses-1"])
      expect([...calls[1].attached].sort()).toEqual(["ses-1", "ses-2"])
    } finally {
      window.onDidChangeWindowState = original
    }
  })

  test("sends snapshots while remote control is disabled", async () => {
    const service = new KiloConnectionService({} as any)
    const calls: Array<{ viewer: { id: string; active: boolean }; attached: string[]; visible: string[] }> = []
    ;(service as any).client = {
      session: {
        viewed: async (input: (typeof calls)[number]) => {
          calls.push(input)
        },
      },
    }
    service.setRemoteService({
      getState: () => ({ enabled: false, connected: false }),
      onChange: () => () => {},
    } as any)

    service.registerVisible("sidebar", ["ses-1"])
    service.registerAttached("agent-manager", ["ses-2"])
    await Bun.sleep(175)

    expect(calls).toHaveLength(1)
    expect([...calls[0].visible].sort()).toEqual(["ses-1"])
    expect([...calls[0].attached].sort()).toEqual(["ses-1", "ses-2"])
  })
})

describe("KiloConnectionService drainPendingPrompts", () => {
  test("ignores stale NotFoundError replies while draining permissions", async () => {
    const service = new KiloConnectionService({} as any)
    const client = {
      project: {
        list: async () => ({ data: [] }),
      },
      permission: {
        list: async () => ({ data: [{ id: "per_test" }] }),
        reply: async () => ({ error: { name: "NotFoundError", data: { message: "missing" } } }),
      },
      question: {
        list: async () => ({ data: [] }),
      },
      suggestion: {
        list: async () => ({ data: [] }),
      },
      network: {
        list: async () => ({ data: [] }),
      },
    }

    ;(service as any).client = client
    ;(service as any).directoryProviders.add(() => ["/tmp/workspace"])

    await expect(service.drainPendingPrompts()).resolves.toBeUndefined()
  })

  test("drains four directories concurrently and suggestions once", async () => {
    const service = new KiloConnectionService({} as any)
    const dirs = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"]
    const gates = new Map(dirs.map((dir) => [dir, Promise.withResolvers<void>()]))
    const fifth = Promise.withResolvers<void>()
    const calls: string[] = []
    let cleared = 0
    const client = {
      permission: {
        list: async ({ directory }: { directory: string }) => {
          calls.push(`permission:${directory}`)
          if (directory === dirs[4]) fifth.resolve()
          await gates.get(directory)!.promise
          return { data: [] }
        },
      },
      question: {
        list: async ({ directory }: { directory: string }) => {
          calls.push(`question:${directory}`)
          return { data: [] }
        },
      },
      suggestion: {
        list: async ({ directory }: { directory: string }) => {
          calls.push(`suggestion:${directory}`)
          return { data: [] }
        },
      },
      network: {
        list: async ({ directory }: { directory: string }) => {
          calls.push(`network:${directory}`)
          return { data: [] }
        },
      },
    }

    ;(service as any).client = client
    ;(service as any).directoryProviders.add(() => dirs)
    service.onClearPendingPrompts(() => cleared++)

    const pending = service.drainPendingPrompts()
    expect(calls).toEqual(dirs.slice(0, 4).map((dir) => `permission:${dir}`))

    gates.get(dirs[0])!.resolve()
    await fifth.promise
    expect(calls.filter((call) => call.startsWith("permission:"))).toEqual(dirs.map((dir) => `permission:${dir}`))

    for (const gate of gates.values()) gate.resolve()
    await pending

    expect(calls.filter((call) => call.startsWith("suggestion:"))).toEqual([`suggestion:${dirs[0]}`])
    const suggestion = calls.findIndex((call) => call.startsWith("suggestion:"))
    expect(calls.filter((call) => call.startsWith("question:")).every((call) => calls.indexOf(call) < suggestion)).toBe(
      true,
    )
    expect(calls.filter((call) => call.startsWith("network:")).every((call) => calls.indexOf(call) > suggestion)).toBe(
      true,
    )
    expect(cleared).toBe(1)
  })

  test("waits for active drains and skips queued directories after a failure", async () => {
    const service = new KiloConnectionService({} as any)
    const dirs = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"]
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    let cleared = 0
    const client = {
      permission: {
        list: async ({ directory }: { directory: string }) => {
          calls.push(directory)
          if (directory === dirs[0]) await release.promise
          if (directory === dirs[1]) return { error: "failed" }
          return { data: [] }
        },
      },
      question: { list: async () => ({ data: [] }) },
      suggestion: { list: async () => ({ data: [] }) },
      network: { list: async () => ({ data: [] }) },
    }

    ;(service as any).client = client
    ;(service as any).directoryProviders.add(() => dirs)
    service.onClearPendingPrompts(() => cleared++)

    const pending = service.drainPendingPrompts()
    expect(calls).toEqual(dirs.slice(0, 4))
    expect(
      await Promise.race([
        pending.then(
          () => "settled",
          () => "settled",
        ),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending")
    expect(calls).not.toContain(dirs[4])

    release.resolve()
    await expect(pending).rejects.toThrow(`Failed to list permissions for ${dirs[1]}`)
    expect(calls).not.toContain(dirs[4])
    expect(cleared).toBe(0)
  })
})

describe("KiloConnectionService server exit handling", () => {
  test("reports signal name when process is killed by signal", () => {
    const service = new KiloConnectionService({} as any)
    let stateErr: Error | undefined
    service.onStateChange((state, err) => {
      if (state === "error") stateErr = err
    })
    ;(service as any).handleServerExit(null, "SIGSEGV")
    expect(stateErr?.message).toBe("CLI background process exited with signal SIGSEGV. Retry to reconnect.")
  })

  test("reports exit code when process exits normally with code", () => {
    const service = new KiloConnectionService({} as any)
    let stateErr: Error | undefined
    service.onStateChange((state, err) => {
      if (state === "error") stateErr = err
    })
    ;(service as any).handleServerExit(1, null)
    expect(stateErr?.message).toBe("CLI background process exited with code 1. Retry to reconnect.")
  })
})

describe("KiloConnectionService manual disconnect", () => {
  type Internals = {
    serverManager: {
      dispose: () => void
      getServer: () => Promise<{ port: number; password: string }>
    }
    checkinTimer: ReturnType<typeof setInterval> | null
    healthPollTimer: ReturnType<typeof setInterval> | null
  }

  function backend(ready = true) {
    const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const requests: string[] = []
    const preconnect = globalThis.fetch.preconnect
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const route = new URL(input instanceof Request ? input.url : String(input)).pathname
          requests.push(route)
          if (route !== "/global/event") return Response.json({})
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  if (!ready) return
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"directory":"/repo","payload":{"type":"server.connected","properties":{}}}\n\n',
                    ),
                  )
                },
                pull(controller) {
                  opened.resolve(controller)
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        },
        { preconnect },
      ),
    )
    const service = new KiloConnectionService({} as vscode.ExtensionContext)
    const internal = service as unknown as Internals
    // Replace process startup and HTTP transport, not the SDK or SSE lifecycle.
    internal.serverManager = {
      dispose: () => {},
      getServer: async () => ({ port: 52512, password: "test" }),
    }
    return {
      service,
      internal,
      opened,
      requests,
      dispose: () => {
        service.dispose()
        transport.mockRestore()
      },
    }
  }

  test("stops the server, reports error, and holds connect until resume", async () => {
    const service = new KiloConnectionService({} as any)
    let disposed = 0
    let spawns = 0
    ;(service as any).serverManager = {
      dispose: () => {
        disposed += 1
      },
      getServer: async () => {
        spawns += 1
        throw new Error("spawn failed")
      },
    }

    const events: Array<{ state: string; error?: string }> = []
    service.onStateChange((state, error) => events.push({ state, error: error?.message }))

    service.disconnect()

    expect(disposed).toBe(1)
    expect(events.at(-1)).toEqual({ state: "error", error: "CLI stopped. Retry to reconnect." })

    await expect(service.connect("/tmp/ws")).rejects.toThrow("CLI is disconnected. Retry to reconnect.")
    await expect(service.getClientAsync("/tmp/ws")).rejects.toThrow("CLI is disconnected. Retry to reconnect.")
    await expect(service.getClientAsync()).rejects.toThrow("CLI is disconnected. Retry to reconnect.")
    expect(spawns).toBe(0)

    service.resume()
    await expect(service.connect("/tmp/ws")).rejects.toThrow("spawn failed")
    expect(spawns).toBe(1)
  })

  test("drops the connected client so getClient() stops serving requests", () => {
    const service = new KiloConnectionService({} as any)
    ;(service as any).serverManager = { dispose: () => {} }
    ;(service as any).client = {}
    ;(service as any).state = "connected"

    service.disconnect()

    expect(() => service.getClient()).toThrow("Not connected")
    expect(service.getConnectionState()).toBe("error")
  })

  test.each(["ready", "failed"] as const)(
    "preserves manual disconnect when a pending server startup becomes %s",
    async (result) => {
      const state = backend()
      const startup = Promise.withResolvers<{ port: number; password: string }>()
      let disposed = 0
      state.internal.serverManager = {
        dispose: () => disposed++,
        getServer: () => startup.promise,
      }

      try {
        const pending = state.service.connect("/tmp/ws")
        state.service.disconnect()
        const error = state.service.getConnectionError()
        if (result === "ready") startup.resolve({ port: 4040, password: "test" })
        if (result === "failed") startup.reject(new Error("startup cancelled"))

        await expect(pending).rejects.toThrow(
          result === "ready" ? "CLI is disconnected. Retry to reconnect." : "startup cancelled",
        )
        expect(disposed).toBe(result === "ready" ? 2 : 1)
        expect(state.service.getConnectionState()).toBe("error")
        expect(state.service.getConnectionError()).toBe(error)
        expect(error?.message).toBe("CLI stopped. Retry to reconnect.")
        expect(state.service.getServerConfig()).toBeNull()
        expect(state.service.getServerInfo()).toBeNull()
        expect(() => state.service.getClient()).toThrow("Not connected")
        expect(state.requests).toEqual([])
      } finally {
        state.dispose()
      }
    },
  )

  test("blocks background clients until resume establishes a fresh SDK connection", async () => {
    const state = backend()
    try {
      const first = await state.service.getClientAsync("/repo")
      expect(state.service.getConnectionState()).toBe("connected")
      state.service.disconnect()

      await expect(state.service.getClientAsync("/repo")).rejects.toThrow("CLI is disconnected")
      await expect(state.service.getClientAsync("/repo/worktree")).rejects.toThrow("CLI is disconnected")
      expect(state.requests.filter((route) => route === "/global/event")).toHaveLength(1)
      expect(state.service.getServerConfig()).toBeNull()
      expect(state.service.getServerInfo()).toBeNull()
      expect(state.internal.checkinTimer).toBeNull()
      expect(state.internal.healthPollTimer).toBeNull()

      state.service.resume()
      const second = await state.service.getClientAsync("/repo")
      expect(second).not.toBe(first)
      expect(state.service.getConnectionState()).toBe("connected")
      expect(state.service.getConnectionError()).toBeNull()
      expect(state.requests.filter((route) => route === "/global/event")).toHaveLength(2)
    } finally {
      state.dispose()
    }
  })

  test("cancels startup before the first SSE event without replacing the manual disconnect error", async () => {
    const state = backend(false)
    try {
      const pending = state.service.connect("/repo")
      await state.opened.promise
      state.service.disconnect()

      await expect(pending).rejects.toThrow("SSE connection ended")
      expect(state.service.getConnectionState()).toBe("error")
      expect(state.service.getConnectionError()?.message).toBe("CLI stopped. Retry to reconnect.")
      expect(state.service.getServerInfo()).toBeNull()
      expect(state.service.getServerConfig()).toBeNull()
      expect(() => state.service.getClient()).toThrow("Not connected")
      expect(state.internal.checkinTimer).toBeNull()
      expect(state.internal.healthPollTimer).toBeNull()
    } finally {
      state.dispose()
    }
  })

  test.each([false, true])(
    "rejects startup disconnected by the connected listener without recreating timers (resume=%s)",
    async (resume) => {
      const state = backend()
      const events: string[] = []
      state.service.onStateChange((event) => {
        events.push(event)
        if (event !== "connected") return
        state.service.disconnect()
        if (resume) state.service.resume()
      })

      try {
        await expect(state.service.connect("/repo")).rejects.toThrow("CLI stopped. Retry to reconnect.")
        expect(events).toContain("connected")
        expect(state.service.getConnectionState()).toBe("error")
        expect(state.service.getConnectionError()?.message).toBe("CLI stopped. Retry to reconnect.")
        expect(() => state.service.getClient()).toThrow("Not connected")
        expect(state.internal.checkinTimer).toBeNull()
        expect(state.internal.healthPollTimer).toBeNull()
      } finally {
        state.dispose()
      }
    },
  )
})
