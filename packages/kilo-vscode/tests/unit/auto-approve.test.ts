import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { registerToggleAutoApprove, type AutoApproveController } from "../../src/commands/toggle-auto-approve"
import { createAutoApproveBridge } from "../../src/kilo-provider/auto-approve"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

type ConfigEvent = { affectsConfiguration(key: string): boolean }

function defer<T>() {
  const state = {} as { resolve: (value: T) => void }
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve
  })
  return { promise, resolve: state.resolve }
}

function config(initial: boolean, info: Record<string, unknown> = {}) {
  const handlers: Array<(event: ConfigEvent) => void> = []
  const updates: Array<{ key: string; value: unknown; target: unknown }> = []
  const messages: string[] = []
  const commands = new Map<string, (...args: unknown[]) => unknown>()
  const state = { active: initial }
  const api = vscode as unknown as {
    workspace: {
      getConfiguration: (section?: string) => {
        get: <T>(key: string, fallback?: T) => T | boolean
        inspect: <T>(key: string) => Record<string, unknown> | undefined
        update: (key: string, value: unknown, target: unknown) => Promise<void>
      }
      onDidChangeConfiguration: (listener: (event: ConfigEvent) => void) => { dispose(): void }
    }
    window: { showInformationMessage: (message: string) => Promise<undefined> }
    commands: { registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => { dispose(): void } }
  }

  api.workspace.getConfiguration = () => ({
    get: (_key, fallback) => state.active ?? fallback,
    inspect: () => info,
    update: async (key, value, target) => {
      updates.push({ key, value, target })
      state.active = Boolean(value)
    },
  })
  api.workspace.onDidChangeConfiguration = (listener) => {
    handlers.push(listener)
    return {
      dispose() {
        const index = handlers.indexOf(listener)
        if (index >= 0) handlers.splice(index, 1)
      },
    }
  }
  api.window.showInformationMessage = async (message) => {
    messages.push(message)
    return undefined
  }
  api.commands.registerCommand = (command, callback) => {
    commands.set(command, callback)
    return { dispose: () => undefined }
  }

  return {
    updates,
    messages,
    commands,
    set active(value: boolean) {
      state.active = value
    },
    emit(key = "kilo-code.new.autoApprove.enabled") {
      for (const handler of handlers) handler({ affectsConfiguration: (name) => name === key })
    },
  }
}

function context() {
  return { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
}

function connection(client: KiloClient | null) {
  const listeners = new Set<(state: "connected" | "disconnected") => void>()
  const svc = {
    getClient: () => {
      if (!client) throw new Error("not connected")
      return client
    },
    onStateChange: (listener: (state: "connected" | "disconnected") => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as KiloConnectionService

  return {
    svc,
    connect() {
      for (const listener of listeners) listener("connected")
    },
  }
}

function client(opts: {
  allowEverything?: (
    args: { enable: boolean; runtime: boolean; directory: string },
    options?: { throwOnError?: boolean },
  ) => Promise<unknown>
}) {
  return {
    permission: {
      allowEverything: async (
        args: { enable: boolean; runtime: boolean; directory: string },
        options?: { throwOnError?: boolean },
      ) => opts.allowEverything?.(args, options),
    },
  } as unknown as KiloClient
}

describe("registerToggleAutoApprove", () => {
  it("restores persisted state, follows config changes, and persists toggles to the closest configured scope", async () => {
    const env = config(true, { workspaceValue: false })
    const enabled = defer<void>()
    const disabled = defer<void>()
    const requests: unknown[] = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (args.enable) enabled.resolve()
          if (!args.enable) disabled.resolve()
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/repo"])
    const changes: boolean[] = []
    ctrl.onChange((active) => changes.push(active))
    await enabled.promise

    expect(ctrl.active()).toBe(true)
    expect(requests).toEqual([{ enable: true, runtime: true, directory: "/repo" }])

    env.active = false
    env.emit()
    await disabled.promise
    expect(ctrl.active()).toBe(false)
    expect(changes).toEqual([false])

    expect(requests).toEqual([
      { enable: true, runtime: true, directory: "/repo" },
      { enable: false, runtime: true, directory: "/repo" },
    ])

    await ctrl.toggle()
    expect(ctrl.active()).toBe(true)
    expect(changes).toEqual([false, true])
    expect(env.updates).toEqual([{ key: "enabled", value: true, target: vscode.ConfigurationTarget.Workspace }])
    expect(env.messages).toContain("Auto-approve enabled")
  })

  it("applies the shield to every tracked worktree and reapplies it after reconnect", async () => {
    config(true)
    const reconnected = defer<void>()
    const requests: unknown[] = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (requests.length === 4) reconnected.resolve()
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => [
      "/workspace",
      "/workspace/.kilo/worktrees/feature",
    ])

    conn.connect()
    await reconnected.promise

    expect(ctrl.active()).toBe(true)
    expect(requests).toHaveLength(4)
    expect(requests.filter((item) => (item as { directory: string }).directory === "/workspace")).toHaveLength(2)
    expect(
      requests.filter((item) => (item as { directory: string }).directory === "/workspace/.kilo/worktrees/feature"),
    ).toHaveLength(2)
  })

  it("does not enable the shield while the backend is unavailable", async () => {
    config(true)
    const conn = connection(null)
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])

    expect(ctrl.active()).toBe(true)
  })

  it("serializes rapid toggles so a stale enable cannot win", async () => {
    config(false)
    const gate = defer<void>()
    const started = defer<void>()
    const requests: Array<{ enable: boolean }> = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (args.enable) {
            started.resolve()
            await gate.promise
          }
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])

    const enable = ctrl.toggle()
    await started.promise
    const disable = ctrl.toggle()
    gate.resolve()
    await Promise.all([enable, disable])

    expect(ctrl.active()).toBe(false)
    expect(requests.map((item) => item.enable)).toEqual([true, false])
  })
})

describe("createAutoApproveBridge", () => {
  it("syncs initial state, consumes toggle requests, forwards unrelated messages, and disposes listeners", async () => {
    const posts: unknown[] = []
    const forwarded: unknown[] = []
    const listeners = new Set<(active: boolean) => void>()
    const state = { active: false }
    const ctrl: AutoApproveController = {
      active: () => state.active,
      toggle: async () => {
        state.active = !state.active
        for (const listener of listeners) listener(state.active)
        return state.active
      },
      onChange(listener) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }
    const bridge = createAutoApproveBridge(
      ctrl,
      (msg) => posts.push(msg),
      async (msg) => {
        forwarded.push(msg)
        return { type: "forwarded" }
      },
    )

    expect(await bridge.handle({ type: "webviewReady" })).toEqual({ type: "forwarded" })
    expect(await bridge.handle({ type: "requestAutoApproveState" })).toBeNull()
    expect(await bridge.handle({ type: "toggleAutoApprove" })).toBeNull()
    expect(await bridge.handle({ type: "other" })).toEqual({ type: "forwarded" })

    expect(posts).toEqual([
      { type: "autoApproveState", active: false },
      { type: "autoApproveState", active: false },
      { type: "autoApproveState", active: true },
    ])
    expect(forwarded).toEqual([{ type: "webviewReady" }, { type: "other" }])

    bridge.dispose()
    state.active = false
    for (const listener of listeners) listener(state.active)
    expect(posts).toHaveLength(3)
  })
})
