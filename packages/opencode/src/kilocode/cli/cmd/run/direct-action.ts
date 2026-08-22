// fork_change - new file
import type { KiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import type { FooterApi } from "@/cli/cmd/run/types"

type Trace = {
  write(type: string, data?: unknown): void
}

export type Command = {
  name: string
  source?: "builtin"
}

export function matches(command: Command | undefined) {
  return command?.name === "shake" && command.source === "builtin"
}

export function run(input: {
  sdk: KiloClient
  sessionID: string
  directory?: string
  signal: AbortSignal
  footer: FooterApi
  trace?: Trace
}) {
  return Effect.promise(() =>
    input.sdk.session.shake(
      { sessionID: input.sessionID, directory: input.directory },
      { signal: input.signal, throwOnError: true },
    ),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        const data = result.data
        input.footer.append({
          kind: "system",
          text: data ? `shake: cleared ${data.parts} tool outputs (~${data.tokens} tokens)` : "shake: completed",
          phase: "final",
          source: "system",
        })
        input.trace?.write("send.shake.ok", {
          sessionID: input.sessionID,
          result: data,
        })
      }),
    ),
  )
}
