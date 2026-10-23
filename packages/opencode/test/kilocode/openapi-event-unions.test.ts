import { describe, expect, it } from "bun:test"
import { Server } from "../../src/server/server"

const ref = "#/components/schemas/EventServerInstanceDisposed"

const union = (schema: unknown): unknown[] => {
  if (schema === null || typeof schema !== "object") return []
  if (!("anyOf" in schema)) return []
  return Array.isArray(schema.anyOf) ? schema.anyOf : []
}

const payload = (schema: unknown): unknown[] => {
  if (schema === null || typeof schema !== "object") return []
  if (!("properties" in schema)) return []
  const properties = schema.properties
  if (properties === null || typeof properties !== "object") return []
  if (!("payload" in properties)) return []
  return union(properties.payload)
}

const refs = (members: readonly unknown[]) =>
  members.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      "$ref" in member &&
      member.$ref === ref,
  ).length

describe("OpenAPI event unions", () => {
  it("lists the disposed event once in Event and GlobalEvent payload", async () => {
    const schemas = (await Server.openapi()).components?.schemas ?? {}

    expect(refs(union(schemas.Event))).toBe(1)
    expect(refs(payload(schemas.GlobalEvent))).toBe(1)
    expect(schemas.EventServerInstanceDisposed).toBeDefined()
  }, 30000)
})
