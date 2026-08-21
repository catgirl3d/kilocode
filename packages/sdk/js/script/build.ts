#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

// kilocode_change start
const retry = async <T>(label: string, fn: () => Promise<T>) => {
  if (process.platform !== "win32") return fn()
  const waits = [50, 100, 200, 400]
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const wait = waits[attempt]
      if (wait === undefined) {
        throw new Error(`${label} failed after ${attempt + 1} attempts`, { cause: error })
      }
      await Bun.sleep(wait)
    }
  }
}
// kilocode_change end

try {
  const openapi = await $`bun dev generate`.cwd(opencode).text()
  await Bun.write("./openapi.json", openapi)

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  paths?: Record<string, unknown>
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "KiloClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// With paramsStructure="flat", @hey-api/openapi-ts preserves required body
// fields in operation data types but does not propagate requestBody.required to
// the flattened class method parameters. Keep this narrow workaround until the
// generator handles that case itself.
const sdkPath = "./src/v2/gen/sdk.gen.ts"
const sdkSource = await retry("MCP SDK required parameters source", () => Bun.file(sdkPath).text())
const requiredMethods = [
  ["Mcp", "add", true, ["name", "config"]],
  ["Auth2", "callback", false, ["code"]],
  ["Mcp", "readResource", true, ["uri", "server"]],
  ["Mcp", "callTool", true, ["server", "name"]],
] as const
const requiredSdk = requiredMethods.reduce((source, [className, name, needsObject, fields]) => {
  const start = source.indexOf(`export class ${className} extends HeyApiClient {`)
  if (start < 0) throw new Error(`Required parameters class not found: ${className}`)
  const end = source.indexOf("\nexport class ", start + 1)
  const section = source.slice(start, end < 0 ? undefined : end)
  const methodStart = section.indexOf(`public ${name}<`)
  if (methodStart < 0) throw new Error(`Required parameters method not found: ${className}.${name}`)
  const methodEnd = section.indexOf("\n    public ", methodStart + 1)
  const method = section.slice(methodStart, methodEnd < 0 ? undefined : methodEnd)
  const signature = needsObject
    ? method.replace(
        new RegExp(`public ${name}<([^>]+)>\\(parameters\\?:`),
        (_match, generic: string) => `public ${name}<${generic}>(parameters:`,
      )
    : method
  if (needsObject && signature === method) {
    throw new Error(`Required parameters object patch did not apply: ${className}.${name}`)
  }
  if (!needsObject && !new RegExp(`public ${name}<[^>]+>\\(parameters:`).test(method)) {
    throw new Error(`Required parameters object already missing: ${className}.${name}`)
  }
  const nextMethod = fields.reduce((value, field) => {
    const next = value.replace(new RegExp(`(${field})\\?:`), "$1:")
    if (next === value) throw new Error(`Required field patch did not apply: ${className}.${name}.${field}`)
    return next
  }, signature)
  const next = section.slice(0, methodStart) + nextMethod + section.slice(methodStart + method.length)
  return source.slice(0, start) + next + source.slice(start + section.length)
}, sdkSource)
await retry("MCP SDK required parameters patch", () => Bun.write(sdkPath, requiredSdk))

await retry("Session history types patch", async () => {
  const generatedTypes = await Bun.file("./src/v2/gen/types.gen.ts").text()
  if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
    throw new Error("Session history generated duplicate Session event variants")
  }
  const historyTypesPatched = generatedTypes.replace(
    /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
    "$1number$2number",
  )
  if (historyTypesPatched === generatedTypes) {
    throw new Error("Session history numeric query patch did not apply")
  }
  await Bun.write("./src/v2/gen/types.gen.ts", historyTypesPatched)
})

await retry("Session history SDK patch", async () => {
  const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
  const historySdkPatched = generatedSdk.replace(
    /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
    "$1number$2number",
  )
  if (historySdkPatched === generatedSdk) {
    throw new Error("Session history numeric SDK patch did not apply")
  }
  await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)
})

// The legacy SDK generator is retired, but this public Config type remains exported.
// Keep Kilo's released sandbox settings aligned with the current generated client.
const legacyTypesPath = "./src/gen/types.gen.ts"
const legacyTypesFile = Bun.file(legacyTypesPath)
const legacySource = await legacyTypesFile.text()
const sandbox = `  /**
   * Sandbox configuration for agent tools
   */
  sandbox?: {
    /**
     * Enable sandbox confinement for new sessions (default: false)
     */
    enabled?: boolean
    /**
     * Control outbound network access from sandboxed tools (default: deny)
     */
    network?: "allow" | "deny"
    /**
     * Additional filesystem paths that sandboxed tools may write to
     */
    writable_paths?: Array<string>
  }
`
const legacyPatched = legacySource.includes(sandbox)
  ? legacySource
  : legacySource.replace("  experimental?: {\n", sandbox + "  experimental?: {\n")
if (!legacyPatched.includes(sandbox)) {
  throw new Error(`Legacy Config sandbox patch did not apply (${legacyTypesPath})`)
}
const instructions = `  /**
   * Instruction entries disabled in this config scope
   */
  instructions_disabled?: Array<string>
`
const legacyNext = legacyPatched.includes(instructions)
  ? legacyPatched
  : legacyPatched.replace("  instructions?: Array<string>\n", "  instructions?: Array<string>\n" + instructions)
if (!legacyNext.includes(instructions)) {
  throw new Error(`Legacy Config instructions_disabled patch did not apply (${legacyTypesPath})`)
}
await Bun.write(legacyTypesPath, legacyNext)

await retry("Prettier", () => $`bun prettier --write src/gen src/v2`)
await $`rm -rf dist tsconfig.tsbuildinfo`
await $`bun tsc`
} finally {
  await retry("OpenAPI cleanup", () => $`rm -f openapi.json`)
}
