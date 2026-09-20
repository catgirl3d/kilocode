import type { McpAddData, McpAuthCallbackData, McpCallToolData, McpReadResourceData } from "../src/v2/gen/types.gen.js"
import type { KiloClient } from "../src/v2/gen/sdk.gen.js"

declare const client: KiloClient

{
  const read: McpReadResourceData = {
    body: { server: "filesystem", uri: "ui://widget" },
    url: "/experimental/resource/read",
  }
  const add: McpAddData = {
    body: { name: "filesystem", config: { type: "remote", url: "https://example.com/mcp" } },
    url: "/mcp",
  }
  const callback: McpAuthCallbackData = {
    body: { code: "oauth-code" },
    path: { name: "filesystem" },
    url: "/mcp/{name}/auth/callback",
  }
  const call: McpCallToolData = {
    body: { name: "search", server: "filesystem" },
    url: "/experimental/mcp/call-tool",
  }
  // @ts-expect-error The public method must not allow an omitted request body.
  client.mcp.readResource()
  // @ts-expect-error uri is required.
  client.mcp.readResource({ server: "filesystem" })
  // @ts-expect-error server is required.
  client.mcp.readResource({ uri: "ui://widget" })
  // @ts-expect-error The public method must not allow an omitted request body.
  client.mcp.callTool()
  // @ts-expect-error server is required.
  client.mcp.callTool({ name: "search" })
  // @ts-expect-error name is required.
  client.mcp.callTool({ server: "filesystem" })
  // @ts-expect-error The public method must require the MCP server payload.
  client.mcp.add()
  // @ts-expect-error name is required.
  client.mcp.add({ config: { type: "remote", url: "https://example.com/mcp" } })
  // @ts-expect-error config is required.
  client.mcp.add({ name: "filesystem" })
  // @ts-expect-error code is required.
  client.mcp.auth.callback({ name: "filesystem" })

  // @ts-expect-error The generated operation data must require a body.
  const missingReadBody: McpReadResourceData = { url: "/experimental/resource/read" }
  // @ts-expect-error The generated operation data must require a body.
  const missingCallBody: McpCallToolData = { url: "/experimental/mcp/call-tool" }
  // @ts-expect-error The generated operation data must require a body.
  const missingAddBody: McpAddData = { url: "/mcp" }
  // @ts-expect-error The generated operation data must require a body.
  const missingCallbackBody: McpAuthCallbackData = {
    path: { name: "filesystem" },
    url: "/mcp/{name}/auth/callback",
  }

  void read
  void call
  void add
  void callback
}
