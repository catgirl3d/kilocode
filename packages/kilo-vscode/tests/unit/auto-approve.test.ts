import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as vscode from "vscode"
import { registerToggleAutoApprove, type AutoApproveController } from "../../src/commands/toggle-auto-approve"
import { createAutoApproveBridge } from "../../src/kilo-provider/auto-approve"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

const ROOT = join(import.meta.dir, "..", "..")
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, { type: string; default?: unknown; scope?: string }> } }
}

const original = {
  workspace: { ...vscode.workspace },
  window: { ...vscode.window },
  commands: { ...vscode.commands },
}

afterEach(() => {
  Object.assign(vscode.workspace, original.workspace)
  Object.assign(vscode.window, original.window)
  Object.assign(vscode.commands, original.commands)
})

type ConfigEvent = { affectsConfiguration(key: string): boolean }
type Layers = { globalValue?: boolean; workspaceValue?: boolean; workspaceFolderValue?: boolean }
type RuntimeRequest = { enable: boolean; runtime: boolean; directory: string }
type Configure = Layers & { fail?: boolean; hold?: (value: unknown) => Promise<void> | undefined }

function defer<T>() {
  return Promise.withResolvers<T>()
}

/** Runs a case with console.error muted while persistence is expected to fail. */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    return await run()
  } finally {
    log.mockRestore()
  }
}

function config(options: Configure = {}) {
  const { fail = false, hold, ...layers } = options
  const handlers: Array<(event: ConfigEvent) => void> = []
  const updates: Array<{ key: string; value: unknown; target: unknown }> = []
  const messages: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const commands = new Map<string, (...args: unknown[]) => unknown>()
  const state: Layers = { ...layers }
  const api = vscode as unknown as {
    workspace: {
      getConfiguration: (section?: string) => {
        get: (key: string, fallback?: unknown) => unknown
        inspect: (key: string) => Record<string, unknown> | undefined
        update: (key: string, value: unknown, target: unknown) => Promise<void>
      }
      onDidChangeConfiguration: (listener: (event: ConfigEvent) => void) => { dispose(): void }
    }
    window: {
      showInformationMessage: (message: string) => Promise<undefined>
      showErrorMessage: (message: string) => Promise<undefined>
      showWarningMessage: (message: string) => Promise<undefined>
    }
    commands: { registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => { dispose(): void } }
  }

  const slot = (target: unknown): keyof Layers => {
    if (target === vscode.ConfigurationTarget.Workspace) return "workspaceValue"
    if (target === vscode.ConfigurationTarget.WorkspaceFolder) return "workspaceFolderValue"
    return "globalValue"
  }

  api.workspace.getConfiguration = () => ({
    get: (_key, fallback) => state.workspaceFolderValue ?? state.workspaceValue ?? state.globalValue ?? fallback,
    inspect: () => {
      const info: Record<string, unknown> = {}
      if (state.globalValue !== undefined) info.globalValue = state.globalValue
      if (state.workspaceValue !== undefined) info.workspaceValue = state.workspaceValue
      if (state.workspaceFolderValue !== undefined) info.workspaceFolderValue = state.workspaceFolderValue
      return info
    },
    update: async (key, value, target) => {
      updates.push({ key, value, target })
      const waiting = hold?.(value)
      if (waiting) await waiting
      if (fail) throw new Error("settings write rejected")
      state[slot(target)] = Boolean(value)
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
  api.window.showErrorMessage = async (message) => {
    errors.push(message)
    return undefined
  }
  api.window.showWarningMessage = async (message) => {
    warnings.push(message)
    return undefined
  }
  api.commands.registerCommand = (command, callback) => {
    commands.set(command, callback)
    return { dispose: () => undefined }
  }

  return {
    layers: state,
    updates,
    messages,
    errors,
    warnings,
    commands,
    emit(key = "kilo-code.new.autoApprove.enabled") {
      for (const handler of handlers) handler({ affectsConfiguration: (name) => name === key })
    },
  }
}

function context() {
  return { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
}

function connection(value: KiloClient | null) {
  let client = value
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
    setClient(value: KiloClient | null) {
      client = value
    },
    emit(state: "connected" | "disconnected" = "connected") {
      for (const listener of listeners) listener(state)
    },
  }
}

function client(opts: {
  allowEverything?: (args: RuntimeRequest, options?: { throwOnError?: boolean }) => Promise<unknown>
}) {
  return {
    permission: {
      allowEverything: async (args: RuntimeRequest, options?: { throwOnError?: boolean }) =>
        opts.allowEverything?.(args, options),
    },
  } as unknown as KiloClient
}

describe("registerToggleAutoApprove", () => {
  it("restores the user setting, follows config changes, and writes toggles to the user setting", async () => {
    const env = config({ globalValue: true, workspaceValue: false })
    const enabled = defer<void>()
    const disabled = defer<void>()
    const requests: RuntimeRequest[] = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (args.enable) enabled.resolve()
          if (!args.enable) disabled.resolve()
          return { data: true }
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/repo"])
    const changes: boolean[] = []
    ctrl.onChange((active) => changes.push(active))

    expect(ctrl.active()).toBe(true)
    await enabled.promise
    expect(requests).toEqual([{ enable: true, runtime: true, directory: "/repo" }])

    env.layers.workspaceValue = true
    env.layers.workspaceFolderValue = true
    env.emit()
    expect(ctrl.active()).toBe(true)

    env.layers.globalValue = false
    env.emit()
    expect(ctrl.active()).toBe(false)
    await disabled.promise
    expect(changes).toEqual([false])

    await ctrl.toggle()
    expect(ctrl.active()).toBe(true)
    expect(changes).toEqual([false, true])
    expect(env.updates).toEqual([{ key: "enabled", value: true, target: vscode.ConfigurationTarget.Global }])
    expect(env.layers.workspaceValue).toBe(true)
    expect(env.layers.workspaceFolderValue).toBe(true)
    expect(env.messages).toContain("Auto-approve enabled")
  })

  it("ignores workspace and folder settings when the user setting is false or absent", () => {
    const env = config({ workspaceValue: true, workspaceFolderValue: true })
    const conn = connection(client({ allowEverything: async () => ({ data: true }) }))
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])
    const changes: boolean[] = []
    ctrl.onChange((active) => changes.push(active))

    expect(ctrl.active()).toBe(false)
    env.emit()
    expect(ctrl.active()).toBe(false)

    env.layers.globalValue = false
    env.emit()
    expect(ctrl.active()).toBe(false)
    expect(changes).toEqual([])
  })

  it("applies the shield to every tracked worktree and reapplies it after reconnect", async () => {
    const done = defer<void>()
    const requests: RuntimeRequest[] = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (requests.length === 4) done.resolve()
          return { data: true }
        },
      }),
    )
    config({ globalValue: true })
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => [
      "/workspace",
      "/workspace/.kilo/worktrees/feature",
    ])

    conn.emit()
    await done.promise

    expect(ctrl.active()).toBe(true)
    expect(requests).toEqual([
      { enable: true, runtime: true, directory: "/workspace" },
      { enable: true, runtime: true, directory: "/workspace/.kilo/worktrees/feature" },
      { enable: true, runtime: true, directory: "/workspace" },
      { enable: true, runtime: true, directory: "/workspace/.kilo/worktrees/feature" },
    ])
  })

  it("does not enable the shield while the backend is unavailable", () => {
    config({ globalValue: true })
    const conn = connection(null)
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])

    expect(ctrl.active()).toBe(true)
  })

  it("reapplies the disabled runtime state after reconnect when the backend was initially unavailable", async () => {
    const done = defer<void>()
    const requests: RuntimeRequest[] = []
    const conn = connection(null)
    config({ globalValue: false })
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/one", "/two"])
    await Promise.resolve()

    conn.setClient(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (requests.length === 2) done.resolve()
          return { data: true }
        },
      }),
    )
    conn.emit()
    await done.promise

    expect(ctrl.active()).toBe(false)
    expect(requests).toEqual([
      { enable: false, runtime: true, directory: "/one" },
      { enable: false, runtime: true, directory: "/two" },
    ])
  })

  it("stops a rapid enable generation before later tracked directories after turning off", async () => {
    const gate = defer<void>()
    const started = defer<void>()
    const requests: RuntimeRequest[] = []
    const conn = connection(null)
    const env = config({ globalValue: false })
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/one", "/two"])
    await Promise.resolve()
    conn.setClient(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          started.resolve()
          await gate.promise
          return { data: true }
        },
      }),
    )

    const enable = ctrl.toggle()
    await started.promise
    const disable = ctrl.toggle()
    gate.resolve()
    await Promise.all([enable, disable])

    expect(ctrl.active()).toBe(false)
    expect(env.layers.globalValue).toBe(false)
    expect(env.messages).toEqual(["Auto-approve disabled"])
    expect(env.warnings).toEqual([])
    expect(requests).toEqual([
      { enable: true, runtime: true, directory: "/one" },
      { enable: false, runtime: true, directory: "/one" },
      { enable: false, runtime: true, directory: "/two" },
    ])
  })

  it("treats unacknowledged runtime responses as failures, continues, and reapplies on reconnect", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const first = defer<void>()
      const second = defer<void>()
      const requests: RuntimeRequest[] = []
      const options: unknown[] = []
      let count = 0
      const conn = connection(
        client({
          allowEverything: async (args, opts) => {
            requests.push(args)
            options.push(opts)
            const index = count++
            if (index === 3) first.resolve()
            if (index === 7) second.resolve()
            if (index === 0) return { data: false }
            if (index === 1) return undefined
            if (index === 2) throw new Error("offline")
            return { data: true }
          },
        }),
      )
      config({ globalValue: true })
      const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/one", "/two", "/three", "/four"])

      await first.promise
      expect(ctrl.active()).toBe(true)
      expect(requests).toHaveLength(4)
      expect(options).toEqual([
        { throwOnError: true },
        { throwOnError: true },
        { throwOnError: true },
        { throwOnError: true },
      ])

      conn.emit()
      await second.promise

      expect(requests).toHaveLength(8)
      expect(requests.slice(4)).toEqual(requests.slice(0, 4))
      expect(log).toHaveBeenCalledTimes(3)
    } finally {
      log.mockRestore()
    }
  })

  it("leaves auto-approve off when the enable setting cannot be saved", async () => {
    const env = config({ globalValue: false, fail: true })
    const requests: RuntimeRequest[] = []
    const conn = connection(null)
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])
    const changes: boolean[] = []
    ctrl.onChange((active) => changes.push(active))

    expect(await quiet(() => ctrl.toggle())).toBe(false)
    expect(ctrl.active()).toBe(false)
    expect(changes).toEqual([false])
    expect(env.errors).toEqual(["Kilo Code could not save the auto-approve setting, so auto-approve stays off."])
    expect(env.warnings).toEqual([])
    expect(requests).toEqual([])
  })

  it("restates the off state when a rejected enable follows an off state", async () => {
    const env = config({ fail: true })
    const ctrl = registerToggleAutoApprove(
      context(),
      connection(client({ allowEverything: async () => ({ data: true }) })).svc,
      () => ["/workspace"],
    )
    const changes: boolean[] = []
    ctrl.onChange((active) => changes.push(active))

    await quiet(() => ctrl.toggle())

    expect(changes).toEqual([false])
    expect(ctrl.active()).toBe(false)
  })

  it("turns off immediately, sends off, and reports a rejected off write", async () => {
    const env = config({ globalValue: true, fail: true })
    const enabled = defer<void>()
    const disabled = defer<void>()
    const requests: RuntimeRequest[] = []
    const conn = connection(
      client({
        allowEverything: async (args) => {
          requests.push(args)
          if (args.enable) enabled.resolve()
          else disabled.resolve()
          return { data: true }
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])
    await enabled.promise

    expect(await quiet(() => ctrl.toggle())).toBe(false)
    await disabled.promise
    expect(ctrl.active()).toBe(false)
    expect(env.layers.globalValue).toBe(true)
    expect(env.errors).toEqual([
      "Kilo Code could not save the auto-approve setting. Auto-approve is off now and turns on again after a restart until that setting is saved.",
    ])
    expect(requests).toEqual([
      { enable: true, runtime: true, directory: "/workspace" },
      { enable: false, runtime: true, directory: "/workspace" },
    ])
  })

  it("serialises quick preference writes so the later intent wins", async () => {
    const gate = defer<void>()
    const started = defer<void>()
    const env = config({
      globalValue: false,
      hold: (value) => {
        if (value !== true) return undefined
        started.resolve()
        return gate.promise
      },
    })
    const ctrl = registerToggleAutoApprove(
      context(),
      connection(client({ allowEverything: async () => ({ data: true }) })).svc,
      () => ["/workspace"],
    )

    const enable = ctrl.toggle()
    await started.promise
    expect(env.updates).toHaveLength(1)

    const disable = ctrl.toggle()
    gate.resolve()
    await Promise.all([enable, disable])

    expect(env.updates.map((entry) => entry.value)).toEqual([true, false])
    expect(env.layers.globalValue).toBe(false)
    expect(ctrl.active()).toBe(false)
  })

  it("warns when the CLI cannot turn off auto-approve", async () => {
    const env = config({ globalValue: true })
    const conn = connection(
      client({
        allowEverything: async (args) => {
          if (!args.enable) throw new Error("offline")
          return { data: true }
        },
      }),
    )
    const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/workspace"])

    expect(await quiet(() => ctrl.toggle())).toBe(false)
    expect(env.layers.globalValue).toBe(false)
    expect(env.messages).not.toContain("Auto-approve disabled")
    expect(env.warnings).toEqual([
      expect.stringContaining(
        "Permissions may still be approved automatically until the extension next connects to the CLI.",
      ),
    ])
  })

  it("warns when auto-approve is enabled without a CLI connection", async () => {
    const env = config({ globalValue: false })
    const ctrl = registerToggleAutoApprove(context(), connection(null).svc, () => ["/workspace"])

    expect(await ctrl.toggle()).toBe(true)
    expect(env.layers.globalValue).toBe(true)
    expect(env.messages).not.toContain("Auto-approve enabled")
    expect(env.warnings).toEqual([
      expect.stringContaining("Auto-approve is saved, but the Kilo CLI has not applied it yet."),
    ])
  })

  it("does not report enable success before runtime sync is confirmed", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const started = defer<void>()
      const gate = defer<void>()
      const requests: RuntimeRequest[] = []
      const env = config({ globalValue: false })
      const conn = connection(null)
      const ctrl = registerToggleAutoApprove(context(), conn.svc, () => ["/one", "/two"])
      await Promise.resolve()
      conn.setClient(
        client({
          allowEverything: async (args) => {
            requests.push(args)
            if (args.directory === "/one") {
              started.resolve()
              await gate.promise
              return { data: false }
            }
            return { data: true }
          },
        }),
      )

      const enable = ctrl.toggle()
      await started.promise
      expect(ctrl.active()).toBe(true)
      expect(env.messages).not.toContain("Auto-approve enabled")
      expect(env.warnings).toEqual([])

      gate.resolve()
      expect(await enable).toBe(true)
      expect(requests).toEqual([
        { enable: true, runtime: true, directory: "/one" },
        { enable: true, runtime: true, directory: "/two" },
      ])
      expect(ctrl.active()).toBe(true)
      expect(env.messages).not.toContain("Auto-approve enabled")
      expect(env.warnings).toEqual([
        expect.stringContaining("Auto-approve is saved, but the Kilo CLI has not applied it yet."),
      ])
    } finally {
      log.mockRestore()
    }
  })
})

describe("auto-approve setting contribution", () => {
  it("declares a user-scoped boolean that starts disabled", () => {
    expect(PACKAGE.contributes.configuration.properties["kilo-code.new.autoApprove.enabled"]).toEqual({
      type: "boolean",
      default: false,
      scope: "application",
      description: expect.any(String),
    })
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
