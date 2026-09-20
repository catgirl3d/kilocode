import path from "node:path"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Option, Schema } from "effect"
import { MCP } from "@/mcp"
import * as OnDemand from "@/kilocode/mcp/on-demand"
import { KilocodeConfig } from "@/kilocode/config/config"
import { testEffect } from "../lib/effect"
const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const local = (extra: Record<string, unknown> = {}) => ({
  type: "local" as const,
  command: [process.execPath, stdioFixture],
  ...extra,
})
describe("MCP on-demand", () => {
  it.instance(
    "initializes on-demand server disabled without tools",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).server?.status).toBe("disabled")
        expect(Object.keys(yield* mcp.tools())).not.toContain("server_current_directory")
      }),
    { config: { mcp: { server: local({ on_demand: true }) } } },
  )
  it.instance(
    "connects on-demand server and exposes tools",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.connect("server")
        expect((yield* mcp.status()).server?.status).toBe("connected")
        expect(Object.keys(yield* mcp.tools())).toContain("server_current_directory")
      }),
    { config: { mcp: { server: local({ on_demand: true }) } } },
  )
  it.instance(
    "does not start disabled on-demand server",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = (yield* mcp.status()).server
        expect(status?.status).toBe("disabled")
        expect(status?.status).not.toBe("failed")
        expect(Object.keys(yield* mcp.tools())).not.toContain("server_current_directory")
      }),
    {
      config: {
        mcp: {
          server: local({
            on_demand: true,
            enabled: false,
            command: [process.execPath, "definitely-missing-fixture.ts"],
          }),
        },
      },
    },
  )
})
describe("MCP on-demand helpers", () => {
  test("filters sanitizes and sorts entries", () => {
    const cfg = {
      mcp: {
        zed: { type: "local", on_demand: true, description: "  z\n  server  " },
        alpha: { type: "remote", on_demand: true, description: "x".repeat(201) },
        disabled: { type: "local", on_demand: true, enabled: false },
        connected: { type: "local", on_demand: true },
        regular: { type: "local" },
      },
    } as never
    expect(OnDemand.entries(cfg, { connected: { status: "connected" } })).toEqual([
      { name: "alpha", description: "x".repeat(200) },
      { name: "zed", description: "z server" },
    ])
  })
  test("renders escaped prompt and omits empty", () => {
    expect(OnDemand.prompt([])).toBeUndefined()
    expect(OnDemand.prompt([{ name: 'a<&"', description: 'd<&"' }])).toBe(
      '<mcp_servers_on_demand>\n  <server name="a&lt;&amp;&quot;" description="d&lt;&amp;&quot;" />\n</mcp_servers_on_demand>',
    )
  })
  test("controls visibility", () => {
    const cfg = { mcp: { server: { type: "local", on_demand: true } } } as never
    expect(OnDemand.visible(cfg, true)).toBe(false)
    expect(OnDemand.visible(cfg, false)).toBe(true)
    expect(
      OnDemand.visible({ mcp: { server: { type: "local", on_demand: true, enabled: false } } } as never, false),
    ).toBe(false)
  })
  test("excludes type-less on-demand overrides consistently", () => {
    const name = "partial"
    const cfg = { mcp: { [name]: { on_demand: true } } } as never
    expect(OnDemand.entries(cfg, {})).toEqual([])
    expect(OnDemand.visible(cfg, false)).toBe(false)
    expect(OnDemand.connectable(cfg, name)).toEqual({
      ok: false,
      reason: 'MCP server "partial" is not fully configured.',
    })
  })
  test("reports connectability", () => {
    const cfg = {
      mcp: {
        valid: { type: "local", on_demand: true },
        regular: { type: "local" },
        disabled: { type: "local", on_demand: true, enabled: false },
        partial: { on_demand: true },
      },
    } as never
    expect(OnDemand.connectable(cfg, "missing")).toEqual({ ok: false, reason: 'MCP server "missing" is unknown.' })
    expect(OnDemand.connectable(cfg, "partial")).toEqual({
      ok: false,
      reason: 'MCP server "partial" is not fully configured.',
    })
    expect(OnDemand.connectable(cfg, "disabled")).toEqual({ ok: false, reason: 'MCP server "disabled" is disabled.' })
    expect(OnDemand.connectable(cfg, "regular")).toEqual({
      ok: false,
      reason: 'MCP server "regular" is not on demand and already starts with the session.',
    })
    expect(OnDemand.connectable(cfg, "valid")).toEqual({ ok: true })
  })
})
test("runtime schema retains on_demand", () => {
  const decoded = Schema.decodeUnknownOption(ConfigV1.Info, { errors: "all", onExcessProperty: "ignore" })({
    mcp: { docs: { on_demand: true } },
  })
  expect(Option.isSome(decoded)).toBe(true)
  if (Option.isSome(decoded)) expect(decoded.value.mcp?.docs).toMatchObject({ on_demand: true })
})
test("project merge keeps local configuration and adds on_demand", () => {
  const merged = KilocodeConfig.mergeProject(
    { mcp: { docs: { type: "local", command: [process.execPath, stdioFixture] } } } as never,
    { mcp: { docs: { on_demand: true } } } as never,
  )
  expect(merged.mcp?.docs).toMatchObject({ type: "local", command: [process.execPath, stdioFixture], on_demand: true })
})

test("escapes newline and tab in catalog server attributes", () => {
  const name = "line\nname\ttail"
  const rendered = OnDemand.prompt([{ name }])
  expect(rendered).toBe('<mcp_servers_on_demand>\n  <server name="line&#10;name&#9;tail" />\n</mcp_servers_on_demand>')
  expect(rendered).not.toContain('name="line\n')
  expect(rendered).not.toContain('name="line\t')
})

test("reports disconnectability for unknown, partial, and on-demand servers", () => {
  const cfg = {
    mcp: {
      valid: { type: "local", on_demand: true, enabled: true },
      disabled: { type: "local", on_demand: true, enabled: false },
      eager: { type: "local" },
      partial: { on_demand: true },
    },
  } as never
  expect(OnDemand.disconnectable(cfg, "missing")).toEqual({
    ok: false,
    reason: 'MCP server "missing" is unknown.',
  })
  expect(OnDemand.disconnectable(cfg, "partial")).toEqual({
    ok: false,
    reason: 'MCP server "partial" is not fully configured.',
  })
  expect(OnDemand.disconnectable(cfg, "eager")).toEqual({
    ok: false,
    reason: 'MCP server "eager" is not on demand; the session manages its lifecycle.',
  })
  expect(OnDemand.disconnectable(cfg, "valid")).toEqual({ ok: true })
  expect(OnDemand.disconnectable(cfg, "disabled")).toEqual({ ok: true })
})
