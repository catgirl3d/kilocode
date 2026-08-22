import * as vscode from "vscode"
// fork_change start
import type { KiloClient } from "@kilocode/sdk/v2/client"
// fork_change end
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
 */
export function registerToggleAutoApprove(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  directories: AllDirectories,
): AutoApproveController {
  // fork_change end
  let active = readActive()
  // Bumped on disable to invalidate in-flight enable drains
  let generation = 0
  // fork_change start
  let queue = Promise.resolve()
  // fork_change end
  const listeners = new Set<(active: boolean) => void>()

  const notify = () => {
    for (const listener of listeners) listener(active)
  }

  const setActive = async (next: boolean) => {
    active = next
    generation++
    notify()
    await vscode.workspace.getConfiguration(CONFIG).update(KEY, active, target())
    // fork_change start
    await sync(generation)
  }

  const sync = (snapshot: number) => {
    queue = queue.then(async () => {
      if (generation !== snapshot) return
      const client = tryGetClient(connectionService)
      if (!client) return
      for (const dir of directories()) {
        if (generation !== snapshot) return
        try {
          await client.permission.allowEverything(
            { enable: active, runtime: true, directory: dir },
            { throwOnError: true },
          )
        } catch (err) {
          console.error("[Kilo New] toggleAutoApprove: failed to update runtime shield:", err)
        }
      }
    })
    return queue
  }
  // fork_change end
  const toggle = async () => {
    await setActive(!active)
    if (!active) {
      vscode.window.showInformationMessage("Auto-approve disabled")
      return active
    }

    vscode.window.showInformationMessage("Auto-approve enabled")
    return active
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${CONFIG}.${KEY}`)) return
      const next = readActive()
      if (next === active) return
      active = next
      generation++
      notify()
      // fork_change start
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
  // fork_change start
  void sync(generation)
  // fork_change end

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
  return vscode.workspace.getConfiguration(CONFIG).get(KEY, false)
}

function target(): vscode.ConfigurationTarget {
  const info = vscode.workspace.getConfiguration(CONFIG).inspect<boolean>(KEY)
  if (info?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder
  if (info?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace
  return vscode.ConfigurationTarget.Global
}

function tryGetClient(connectionService: KiloConnectionService): KiloClient | undefined {
  try {
    return connectionService.getClient()
  } catch {
    return undefined
  }
}
