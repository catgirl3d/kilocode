import { Schema } from "effect"
import { EventManifest } from "@/event-manifest" // kilocode_change

export type Definition<Type extends string = string, Properties extends Schema.Top = Schema.Top> = {
  type: Type
  properties: Properties
}

const registry = new Map<string, Definition>()

export function define<Type extends string, Properties extends Schema.Top>(
  type: Type,
  properties: Properties,
): Definition<Type, Properties> {
  const result = { type, properties }
  registry.set(type, result)
  return result
}

function build() { // kilocode_change - [fork] build the shared event payload schema array once
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(type),
          properties: def.properties,
        }).annotate({ identifier: `Event.${type}` }),
      )
      .toArray(),
    // kilocode_change start - expose current Effect events through legacy bus schemas
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(definition.type),
          properties: definition.data,
        }).annotate({ identifier: `Event.${definition.type}` }),
      )
      .toArray(),
    // kilocode_change end
  ]
}

// kilocode_change start - [fork] share one materialized event payload array across Event/GlobalEvent unions
let payloads: ReturnType<typeof build> | undefined

export function effectPayloads() {
  return (payloads ??= build())
}
// kilocode_change end

export * as BusEvent from "./bus-event"
