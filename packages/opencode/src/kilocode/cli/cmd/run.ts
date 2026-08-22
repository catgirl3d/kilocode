import type { KiloClient } from "@kilocode/sdk/v2"
import { KiloRunDrain } from "../run-drain"
import { UI } from "@/cli/ui"
import { DaemonClient } from "@/kilocode/daemon/client"
import { isBuiltinCommand, type BuiltinCommand } from "@/kilocode/session/builtin-commands"
import { Provider } from "@/provider/provider"
import { Filesystem } from "@/util/filesystem"

export namespace KiloRun {
  // kilocode_change start
  // Shared by headless JSON output and its deterministic contract tests.
  export function jsonRecord(
    type: string,
    sessionID: string,
    data: Record<string, unknown>,
    timestamp = Date.now(),
  ): Record<string, unknown> {
    return { type, timestamp, sessionID, ...data }
  }

  export function builtinCompletion(command: BuiltinCommand, result: { data?: unknown }) {
    if (command !== "shake" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return
    return result.data as Record<string, unknown>
  }
  // kilocode_change end
  export async function resolveBuiltin(sdk: KiloClient, command?: string, directory?: string) {
    if (!isBuiltinCommand(command)) return
    const result = await sdk.command.list({ directory })
    // kilocode_change start
    if (result.error) return command
    if (result.data?.some((item) => item.name === command && item.source !== "builtin")) return
    // kilocode_change end
    return command
  }

  export function validateBuiltin(args: { command?: BuiltinCommand; continue?: boolean; session?: string }) {
    if (!args.command) return
    if (args.continue || args.session) return
    UI.error(`--command ${args.command} requires --continue or --session`)
    process.exit(1)
  }

  export async function runBuiltin(
    sdk: KiloClient,
    sessionID: string,
    command: BuiltinCommand,
    model?: string,
    current?: { id: string; providerID: string },
    directory?: string,
  ) {
    switch (command) {
      case "compact":
      case "summarize":
        // kilocode_change start
        const selected = resolve(model, current)
        if (!selected) {
          UI.error("No model specified and session has no model")
          process.exit(1)
        }
        // kilocode_change end
        return sdk.session.summarize({
          sessionID,
          directory,
          providerID: selected.providerID,
          modelID: selected.modelID,
        })
      // kilocode_change start
      case "shake":
        return sdk.session.shake({ sessionID, directory })
      // kilocode_change end
    }
  }
}

export namespace KiloRunDaemon {
  export type Input = {
    directory?: string
    execute: (client: KiloClient) => Promise<void>
  }

  export async function attach(input: Input) {
    const daemon = await DaemonClient.maybe()
    if (!daemon) return false
    const dir = input.directory ?? Filesystem.resolve(process.cwd())
    const client = KiloRunDrain.client({ baseUrl: daemon.url, directory: dir, headers: daemon.headers })
    await input.execute(client)
    return true
  }
}

function resolve(model?: string, current?: { id: string; providerID: string }) {
  if (model) {
    const parsed = Provider.parseModel(model)
    return { providerID: parsed.providerID, modelID: parsed.modelID }
  }
  if (!current) return
  return { providerID: current.providerID, modelID: current.id }
}
