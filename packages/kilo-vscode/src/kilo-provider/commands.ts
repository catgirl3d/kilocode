import type { KiloClient } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"

const promises = new Map<string, Promise<unknown>>()

export function clearCommandsCache(): void {
  promises.clear()
}

export async function loadCommands(client: KiloClient, dir: string): Promise<unknown> {
  const pending = promises.get(dir)
  if (pending) return pending

  const promise = retry(() => client.command.list({ directory: dir }, { throwOnError: true })).then(({ data }) => ({
    type: "commandsLoaded",
    commands: data.map((cmd) => {
      // fork_change start
      if ("kind" in cmd) {
        return {
          name: cmd.name,
          description: cmd.description,
          source: cmd.source,
          hints: [],
        }
      }
      // fork_change end
      // fork_change start
      return {
        name: cmd.name,
        description: cmd.description,
        agent: cmd.agent,
        model: cmd.model,
        variant: cmd.variant,
        source: cmd.source,
        hints: cmd.hints,
      }
      // fork_change end
    }),
  }))

  promises.set(dir, promise)
  try {
    return await promise
  } finally {
    // Clear the cache entry once the request settles so subsequent calls
    // fetch fresh data. Identity check guards against clear-then-restart
    // races: if clearCommandsCache() wiped the map and a new loadCommands()
    // already stored a fresh promise, don't delete its entry.
    if (promises.get(dir) === promise) promises.delete(dir)
  }
}
