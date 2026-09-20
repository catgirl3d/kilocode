import * as vscode from "vscode"
import type { KiloClient } from "@kilocode/sdk/v2/client" // fork_change
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

/**
 * Returns every unique directory the extension tracks
 * (workspace root + all registered worktree paths).
 */
export type AllDirectories = () => string[]
export interface AutoApproveController {
  active(): boolean
  toggle(): Promise<boolean>
  onChange(listener: (active: boolean) => void): { dispose(): void }
}

const CONFIG = "kilo-code.new.autoApprove"
const KEY = "enabled"

// fork_change start
/**
 * Runtime auto-accept toggle for permissions. The persisted extension setting is
 * applied to each directory-scoped backend without writing global allow rules.
 *
 * The setting is user scoped: the controller follows the user value, and the toggle is
 * written to the user setting. Enabling saves that setting first, so a save that fails
 * leaves auto-approve off and says so. Disabling takes effect in memory at once and
 * still reports a rejected write.
 */
// fork_change end
export function registerToggleAutoApprove(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  directories: AllDirectories,
): AutoApproveController {
  let active = readActive()
  // Bumped on state changes to invalidate in-flight runtime syncs. // fork_change
  let generation = 0
  let queue: Promise<boolean> = Promise.resolve(true) // fork_change
  const listeners = new Set<(active: boolean) => void>()

  const notify = () => {
    for (const listener of listeners) listener(active)
  }

  const apply = (next: boolean) => {
    if (next === active) return
    active = next
    generation++
    notify()
  }

  // Serialize preference writes, but do not keep the transition open on a server RPC. // fork_change
  let transitions: Promise<unknown> = Promise.resolve()
  const transition = <T>(run: () => Promise<T>): Promise<T> => {
    const next = transitions.then(run, run)
    transitions = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const save = async (next: boolean): Promise<boolean> => {
    try {
      await vscode.workspace.getConfiguration(CONFIG).update(KEY, next, vscode.ConfigurationTarget.Global)
      return true
    } catch (error) {
      console.error("[Kilo New] toggleAutoApprove: failed to save the setting:", error)
      vscode.window.showErrorMessage(
        next
          ? "Kilo Code could not save the auto-approve setting, so auto-approve stays off."
          : "Kilo Code could not save the auto-approve setting. Auto-approve is off now and turns on again after a restart until that setting is saved.",
      )
      return false
    }
  }

  // fork_change start
  const sync = (snapshot: number): Promise<boolean> => {
    queue = queue.then(async () => {
      if (generation !== snapshot) return false
      const client = tryGetClient(connectionService)
      if (!client) return false
      const enable = active
      let synced = true
      for (const dir of directories()) {
        if (generation !== snapshot) return false
        try {
          const response = await client.permission.allowEverything(
            { enable, runtime: true, directory: dir },
            { throwOnError: true },
          )
          if (response?.data !== true) throw new Error("runtime shield update was not acknowledged")
        } catch (err) {
          synced = false
          console.error("[Kilo New] toggleAutoApprove: failed to update runtime shield:", err)
        }
      }
      return generation === snapshot && synced
    })
    return queue
  }
  // fork_change end
  const setActive = async (next: boolean): Promise<boolean> => {
    if (next) {
      if (await save(true)) {
        apply(true)
        void sync(generation) // fork_change
        return true
      }
      // The setting still says off. Tell every listener the state it now holds.
      active = false
      generation++
      notify()
      return false
    }
    apply(false)
    void sync(generation) // fork_change
    return save(false)
  }

  const toggle = async () => {
    const turned = await transition(async () => {
      const next = !active
      const saved = await setActive(next)
      return { next, saved, snapshot: generation, queue } // fork_change
    })
    // fork_change start
    const synced = await turned.queue
    if (!turned.saved || generation !== turned.snapshot) return active
    if (!synced) {
      vscode.window.showWarningMessage(
        turned.next
          ? "Auto-approve is saved, but the Kilo CLI has not applied it yet. It applies when the extension next connects to the CLI."
          : "Auto-approve is off in settings, but the Kilo CLI has not confirmed it. Permissions may still be approved automatically until the extension next connects to the CLI.",
      )
      return active
    }
    if (!turned.next) {
      vscode.window.showInformationMessage("Auto-approve disabled")
      return active
    }
    vscode.window.showInformationMessage("Auto-approve enabled")
    return active
    // fork_change end
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${CONFIG}.${KEY}`)) return
      // fork_change start
      const next = readActive()
      if (next === active) return
      apply(next)
      void sync(generation)
      // fork_change end
    }),
  )

  // fork_change start
  context.subscriptions.push({
    dispose: connectionService.onStateChange((state) => {
      if (state === "connected") void sync(generation)
    }),
  })
  // fork_change end

  context.subscriptions.push(vscode.commands.registerCommand("kilo-code.new.toggleAutoApprove", toggle))
  void sync(generation) // fork_change

  return {
    active: () => active,
    toggle,
    onChange(listener) {
      listeners.add(listener)
      let disposed = false
      return {
        dispose() {
          if (disposed) return
          disposed = true
          listeners.delete(listener)
        },
      }
    },
  }
}

function readActive(): boolean {
  return vscode.workspace.getConfiguration(CONFIG).inspect<boolean>(KEY)?.globalValue === true
}

function tryGetClient(connectionService: KiloConnectionService): KiloClient | undefined {
  try {
    return connectionService.getClient()
  } catch {
    return undefined
  }
}
