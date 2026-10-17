// fork_change - new file
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "node:path"

export function collect(messages: ReadonlyArray<Pick<SessionV1.WithParts, "parts">>, directory: string) {
  const files = new Set<string>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "patch") continue

      for (const file of part.files) {
        const relative = path.relative(directory, file).replaceAll("\\", "/")
        if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue
        files.add(relative)
      }
    }
  }

  return [...files].sort()
}
