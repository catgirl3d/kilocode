import { describe, expect, mock, test } from "bun:test"
import type { Snapshot } from "../../../client"

const snap = {
  effective: { mcp: { demo: { type: "local", command: ["old-server"], on_demand: true, description: "Demo" } } },
  overlay: { collections: { mcp: [] }, scope: "project" },
  mcp: {},
} as unknown as Snapshot
const falseSnap = {
  effective: { mcp: { demo: { type: "local", command: ["old-server"], on_demand: true } } },
  overlay: {
    collections: {
      mcp: [
        {
          key: "demo",
          path: ["mcp", "demo"],
          local: { type: "local", command: ["old-server"], enabled: true, on_demand: false },
          global: { type: "local", command: ["old-server"], enabled: true, on_demand: true },
          source: "project",
          inherited: false,
          overridden: true,
          editable: true,
        },
      ],
    },
    scope: "project",
  },
  mcp: {},
} as unknown as Snapshot
let currentSnap = snap
let saved: unknown
const ctx = {
  data: () => currentSnap,
  query: () => undefined,
  saving: () => undefined,
  failure: () => undefined,
  target: () => ({ url: "http://localhost", dir: ".", scope: "project" as const }),
  fail: () => undefined,
  run: () => undefined,
  save: (patch: unknown) => {
    saved = patch
  },
  patch: () => undefined,
  unset: () => undefined,
  tui: () => undefined,
}

mock.module("solid-js", () => ({
  createMemo: (fn: () => unknown) => fn,
  createResource: () => [Object.assign(() => [], { error: undefined }), {}],
  createSignal: (initial: unknown) => {
    let value = initial
    return [
      () => value,
      (next: unknown) => {
        value = next
      },
    ]
  },
}))
mock.module("../../../context/config", () => ({ useConfig: () => ctx }))
if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", { value: { fetch: globalThis.fetch }, configurable: true })
}
const { preserveMcpPresets, useMcpSettings } = await import("./mcp")

describe("MCP config preservation", () => {
  test("preserves on-demand fields for a local server", () => {
    const next = { type: "local", command: ["server"] }

    expect(
      preserveMcpPresets(next, {
        type: "local",
        command: ["old-server"],
        on_demand: true,
        description: "Local server",
      }),
    ).toEqual({ ...next, on_demand: true, description: "Local server" })
  })

  test("preserves on-demand fields for a remote server", () => {
    const next = { type: "remote", url: "https://example.com/mcp" }

    expect(
      preserveMcpPresets(next, {
        type: "remote",
        url: "https://old.example.com/mcp",
        on_demand: true,
        description: "Remote server",
      }),
    ).toEqual({ ...next, on_demand: true, description: "Remote server" })
  })

  test("does not add absent on-demand fields", () => {
    const next = { type: "local", command: ["server"] }

    expect(preserveMcpPresets(next, { type: "local", command: ["server"] })).toEqual(next)
  })

  test("does not alter the built config while preserving fields", () => {
    const next = {
      type: "remote",
      url: "https://example.com/mcp",
      enabled: false,
      headers: null,
      oauth: null,
      timeout: null,
    }

    expect(preserveMcpPresets(next, { on_demand: true, description: "Remote server" })).toEqual({
      ...next,
      on_demand: true,
      description: "Remote server",
    })
    expect(next).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      enabled: false,
      headers: null,
      oauth: null,
      timeout: null,
    })
  })

  test("save preserves on-demand fields when editing an existing server", () => {
    {
      const settings = useMcpSettings()
      const row = settings.rows().at(0)
      if (!row) throw new Error("Expected an MCP row")
      settings.edit(row)
      settings.save()
    }

    expect(saved).toEqual({
      mcp: {
        demo: {
          type: "local",
          command: ["old-server"],
          enabled: true,
          url: null,
          headers: null,
          oauth: null,
          env: null,
          environment: null,
          timeout: null,
          on_demand: true,
          description: "Demo",
        },
      },
    })
  })
  test("save preserves an explicit project on-demand false", () => {
    currentSnap = falseSnap
    saved = undefined
    const settings = useMcpSettings()
    const row = settings.rows().at(0)
    if (!row) throw new Error("Expected an MCP row")
    settings.edit(row)
    settings.save()

    expect((saved as { mcp: { demo: { on_demand?: boolean } } }).mcp.demo.on_demand).toBe(false)
  })
})
