// kilocode_change - server command discovery metadata
import { Command } from "@/command"
import { BUILTIN_COMMAND_CATALOG } from "@/kilocode/session/builtin-commands"
import { Schema } from "effect"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.Literal("builtin"),
  kind: Schema.Literal("action"),
}).annotate({ identifier: "BuiltinAction" })

export const Catalog = Schema.Union([Command.Info, Info]).annotate({ identifier: "CommandCatalog" })

export type Catalog = typeof Catalog.Type

export function list(commands: readonly Command.Info[]): Catalog[] {
  const result: Catalog[] = [...commands]
  const names = new Set(result.map((item) => item.name))
  for (const item of BUILTIN_COMMAND_CATALOG) {
    if (names.has(item.name)) continue
    result.push(item)
  }
  return result
}
