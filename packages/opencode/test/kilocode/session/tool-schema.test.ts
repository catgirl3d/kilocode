import { describe, expect, test } from "bun:test"
import { asSchema, jsonSchema, type JSONSchema7, tool } from "ai"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { KiloToolSchema } from "@/kilocode/session/tool-schema"

describe("provider tool schema sanitization", () => {
  test("removes lookarounds without changing safe regex syntax or local validation", async () => {
    const email =
      "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    const escaped = String.raw`\(?=literal\)`
    const doubled = String.raw`\\(?=suffix)`
    const seen: unknown[] = []
    const schema: JSONSchema7 = {
      type: "object",
      examples: [{ pattern: "(?=annotation)" }],
      patternProperties: {
        "[(?=]": { type: "string" },
        [escaped]: { type: "string" },
      },
      properties: {
        email: { type: "string", format: "email", pattern: email },
        ahead: { type: "string", pattern: "value(?=suffix)" },
        behind: { type: "string", pattern: "(?<=prefix)value" },
        negative: { type: "string", pattern: "(?<!prefix)value" },
        slug: { type: "string", pattern: "^[a-z0-9-]+$" },
        class: { type: "string", pattern: "[(?=]" },
        escaped: { type: "string", pattern: escaped },
        doubled: { type: "string", pattern: doubled },
        named: { type: "string", pattern: "(?<name>value)" },
      },
    }
    const validate = (value: unknown) => {
      seen.push(value)
      return { success: true as const, value }
    }
    const execute = async () => ({ output: "ok" })
    const input = {
      invite: tool({ description: "Invite by email", inputSchema: jsonSchema(schema, { validate }), execute }),
    }

    const output = await KiloToolSchema.sanitize(input)
    const result = (await asSchema(output.invite.inputSchema).jsonSchema) as JSONSchema7
    const properties = result.properties as Record<string, JSONSchema7>

    expect(output).not.toBe(input)
    expect(output.invite.execute).toBe(execute)
    expect(properties.email).toEqual({ type: "string", format: "email" })
    expect(properties.ahead.pattern).toBeUndefined()
    expect(properties.behind.pattern).toBeUndefined()
    expect(properties.negative.pattern).toBeUndefined()
    expect(properties.slug.pattern).toBe("^[a-z0-9-]+$")
    expect(properties.class.pattern).toBe("[(?=]")
    expect(properties.escaped.pattern).toBe(escaped)
    expect(properties.doubled.pattern).toBeUndefined()
    expect(properties.named.pattern).toBe("(?<name>value)")
    expect(result.examples).toEqual([{ pattern: "(?=annotation)" }])
    expect(result.patternProperties).toEqual({
      "[(?=]": { type: "string" },
      [escaped]: { type: "string" },
    })
    expect((schema.properties?.email as JSONSchema7).pattern).toBe(email)

    await asSchema(output.invite.inputSchema).validate?.({ email: "person@example.com" })
    expect(seen).toEqual([{ email: "person@example.com" }])
  })

  test("returns the original tools when schemas do not change", async () => {
    const input = {
      lookup: tool({ inputSchema: jsonSchema({ type: "object", properties: { slug: { pattern: "^[a-z]+$" } } }) }),
    }

    expect(await KiloToolSchema.sanitize(input)).toBe(input)
  })

  test("keeps strict dynamic properties available when their key pattern is removed", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      patternProperties: {
        "^(?!reserved$).+$": { type: "string", minLength: 1, pattern: "(?=value)" },
        "^safe-": { type: "number" },
      },
      additionalProperties: false,
    }
    const input = { dynamic: tool({ inputSchema: jsonSchema(schema) }) }

    const output = await KiloToolSchema.sanitize(input)
    const result = (await asSchema(output.dynamic.inputSchema).jsonSchema) as JSONSchema7

    expect(result).toEqual({ type: "object", additionalProperties: true })
    expect(schema.patternProperties).toEqual({
      "^(?!reserved$).+$": { type: "string", minLength: 1, pattern: "(?=value)" },
      "^safe-": { type: "number" },
    })
    expect(schema.additionalProperties).toBe(false)
  })

  test("keeps object inputs available when an exact-match branch is widened", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: { x: { type: "string", pattern: "(?=value)" } },
          required: ["x"],
        },
        {
          type: "object",
          properties: { y: { type: "string" } },
          required: ["y"],
        },
      ],
    }
    const input = { exact: tool({ inputSchema: jsonSchema(schema) }) }

    const output = await KiloToolSchema.sanitize(input)
    const result = await asSchema(output.exact.inputSchema).jsonSchema

    expect(result).toEqual({ type: "object", additionalProperties: true })
  })
})

const KEY = "sk-test-1234567890abcdefghijklmnop"

describe("outbound tool schema redaction", () => {
  test("preserves a oneOf reference when only descriptions need redaction", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      additionalProperties: false,
      description: `Search with ${KEY}`,
      oneOf: [{ $ref: "#/definitions/query" }, { type: "object", required: ["id"] }],
      definitions: { query: { type: "object", description: `Example ${KEY}`, required: ["query"] } },
    }
    const input = { search: tool({ inputSchema: jsonSchema(schema) }) }
    const output = await KiloToolSchema.sanitize(input, true)

    expect(await asSchema(output.search.inputSchema).jsonSchema).toEqual({
      ...schema,
      description: "Search with [redacted]",
      definitions: { query: { type: "object", description: "Example [redacted]", required: ["query"] } },
    })
  })

  test("scrubs top-level and nested descriptions while keeping the validator and execute", async () => {
    const seen: unknown[] = []
    const schema: JSONSchema7 = {
      type: "object",
      description: `outer ${KEY}`,
      properties: {
        query: {
          type: "object",
          description: `nested ${KEY}`,
          properties: {
            text: { type: "string", description: `leaf ${KEY}` },
          },
        },
      },
    }
    const validate = (value: unknown) => {
      seen.push(value)
      return { success: true as const, value }
    }
    const execute = async () => ({ output: "ok" })
    const input = {
      search: tool({ description: `tool ${KEY}`, inputSchema: jsonSchema(schema, { validate }), execute }),
    }

    const output = await KiloToolSchema.sanitize(input, true)
    const result = (await asSchema(output.search.inputSchema).jsonSchema) as JSONSchema7

    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(result.description).toContain("[redacted]")
    expect(output.search.description).toContain("[redacted]")
    expect(output.search.execute).toBe(execute)
    await asSchema(output.search.inputSchema).validate?.({ query: { text: "x" } })
    expect(seen).toEqual([{ query: { text: "x" } }])
    expect(JSON.stringify(schema)).toContain(KEY)
  })

  test("blocks a key in an enum, default or property name", async () => {
    const enumSchema: JSONSchema7 = { type: "string", enum: [KEY] }
    await expect(
      KiloToolSchema.sanitize({ pick: tool({ inputSchema: jsonSchema(enumSchema) }) }, true),
    ).rejects.toBeInstanceOf(MemoryRedact.Failure)

    const defaultSchema: JSONSchema7 = { type: "string", default: KEY }
    await expect(
      KiloToolSchema.sanitize({ pick: tool({ inputSchema: jsonSchema(defaultSchema) }) }, true),
    ).rejects.toBeInstanceOf(MemoryRedact.Failure)

    const nameSchema: JSONSchema7 = { type: "object", properties: { [KEY]: { type: "string" } } }
    await expect(
      KiloToolSchema.sanitize({ pick: tool({ inputSchema: jsonSchema(nameSchema) }) }, true),
    ).rejects.toBeInstanceOf(MemoryRedact.Failure)

    await expect(
      KiloToolSchema.sanitize({ [KEY]: tool({ inputSchema: jsonSchema({ type: "object" }) }) }, true),
    ).rejects.toBeInstanceOf(MemoryRedact.Failure)
  })

  test("redact=false keeps the legacy schema and description untouched", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      description: `outer ${KEY}`,
      properties: { query: { type: "string" } },
    }
    const input = { search: tool({ description: `tool ${KEY}`, inputSchema: jsonSchema(schema) }) }

    const output = await KiloToolSchema.sanitize(input)
    expect(output).toBe(input)
    expect(JSON.stringify(await asSchema(output.search.inputSchema).jsonSchema)).toContain(KEY)
    expect(output.search.description).toBe(`tool ${KEY}`)
  })
})
