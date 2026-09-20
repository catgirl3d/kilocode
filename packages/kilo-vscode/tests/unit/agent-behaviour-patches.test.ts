import { describe, expect, it } from "bun:test"
import {
  mcpConfigPatch,
  mcpConfigScope,
  mcpDisplayEntry,
  mcpScopedEntry,
  mcpSwitchAction,
  mcpSwitchChecked,
  mcpStatusKey,
  mcpStatusTone,
  mcpToggle,
  removable,
  selectedAgentNumberOverrideValue,
  selectedAgentTextOverrideValue,
  selectedDefaultAgentValue,
  shouldClearDefaultAgentWhenAgentBecomesUnavailable,
} from "../../webview-ui/src/components/settings/agent-behaviour-patches"

describe("removable", () => {
  it("only allows user-managed custom agents", () => {
    expect(removable({ name: "reviewer", mode: "primary", native: false })).toBe(true)
    expect(removable({ name: "code", mode: "primary", native: true })).toBe(false)
    expect(removable({ name: "managed", mode: "primary", source: "organization" })).toBe(false)
    expect(removable(undefined)).toBe(false)
  })
})

describe("mcpStatusKey", () => {
  it("uses the disabled label when runtime status is stale", () => {
    expect(mcpStatusKey("connected", "disabled")).toBe("mcp.status.disabled")
    expect(mcpStatusKey("failed", "disabled")).toBe("mcp.status.disabled")
    expect(mcpStatusKey("disabled", "available")).toBe("mcp.status.ready_on_demand")
  })
})

describe("mcpConfigScope", () => {
  it("routes project-defined servers to project config", () => {
    expect(
      mcpConfigScope("docs", {
        mcp: [{ key: "docs", source: "project" }],
      }),
    ).toBe("project")
  })

  it("routes global servers to global config", () => {
    const collections = {
      mcp: [{ key: "docs", source: "global" as const }],
    }
    expect(mcpConfigScope("docs", collections)).toBe("global")
  })

  it("keeps system, default, and unknown servers runtime-only", () => {
    const collections = {
      mcp: [
        { key: "legacy", source: "system" as const },
        { key: "builtin", source: "default" as const },
      ],
    }
    expect(mcpConfigScope("legacy", collections)).toBeUndefined()
    expect(mcpConfigScope("builtin", collections)).toBeUndefined()
    expect(mcpConfigScope("unknown", collections)).toBeUndefined()
  })
})

describe("mcpScopedEntry", () => {
  it("overlays scoped values while preserving merged-only fields", () => {
    expect(
      mcpScopedEntry(
        { command: ["server"], on_demand: false, description: "merged" },
        { on_demand: true, description: "scoped" },
      ),
    ).toEqual({ command: ["server"], on_demand: true, description: "scoped" })
  })

  it("returns the merged entry when no scoped entry exists", () => {
    const merged = { url: "https://example.com", on_demand: true }
    expect(mcpScopedEntry(merged, undefined)).toBe(merged)
  })
})

describe("mcpDisplayEntry", () => {
  it("deeply merges records and replaces scalars and arrays", () => {
    expect(
      mcpScopedEntry(
        { environment: { A: "old", B: "keep" }, command: ["merged"], description: "merged" },
        { environment: { A: "new" }, command: ["scoped"], description: undefined },
      ),
    ).toEqual({ environment: { A: "new", B: "keep" }, command: ["scoped"], description: undefined })
  })

  it("applies the draft after the scoped layer, including undefined deletion", () => {
    expect(
      mcpDisplayEntry(
        { description: "merged", environment: { A: "merged", B: "keep" } },
        { description: "scoped", environment: { A: "scoped" } },
        { description: undefined, environment: { B: "draft" } },
      ),
    ).toEqual({ description: undefined, environment: { A: "scoped", B: "draft" } })
  })

  it("returns undefined when every display layer is undefined", () => {
    expect(mcpDisplayEntry(undefined, undefined, undefined)).toBeUndefined()
  })
})

describe("mcpStatusTone", () => {
  it.each([
    ["connected", true, true, "connected"],
    ["failed", true, true, "failed"],
    ["needs_auth", true, true, "attention"],
    ["needs_client_registration", true, true, "attention"],
    ["disabled", true, true, "available"],
    ["disabled", true, false, "disabled"],
    ["disabled", false, true, "disabled"],
    ["connected", false, true, "disabled"],
    ["failed", false, true, "disabled"],
  ])("maps %s with enabled=%s and onDemand=%s to %s", (status, enabled, onDemand, expected) => {
    expect(mcpStatusTone(status, enabled, onDemand)).toBe(expected)
  })

  it("maps missing and unknown statuses to unknown", () => {
    expect(mcpStatusTone(undefined, true, true)).toBe("unknown")
    expect(mcpStatusTone("starting", true, true)).toBe("unknown")
  })
})

describe("mcpSwitchChecked", () => {
  it("uses config enabled for on-demand servers", () => {
    expect(mcpSwitchChecked("disabled", true, true)).toBe(true)
    expect(mcpSwitchChecked("disabled", false, true)).toBe(false)
    expect(mcpSwitchChecked("connected", false, true)).toBe(false)
  })

  it("uses runtime connection for eager servers", () => {
    expect(mcpSwitchChecked("connected", true, false)).toBe(true)
    expect(mcpSwitchChecked("disabled", true, false)).toBe(false)
  })
})

describe("mcpSwitchAction", () => {
  it.each([
    [true, true, "none"],
    [true, false, "disconnect"],
    [false, true, "connect"],
    [false, false, "disconnect"],
  ])("maps onDemand=%s and enabled=%s to %s", (onDemand, enabled, expected) => {
    expect(mcpSwitchAction(enabled, onDemand)).toBe(expected)
  })

  it("persists enabling an on-demand server without a runtime connect", () => {
    expect(mcpConfigPatch("docs", { mcp: [{ key: "docs", source: "global" }] }, { enabled: true })).toEqual({
      scope: "global",
      patch: { mcp: { docs: { enabled: true } } },
    })
    expect(mcpSwitchAction(true, true)).toBe("none")
  })

  it("applies an on-demand toggle without invoking connect", () => {
    const updates: Array<[string, unknown]> = []
    const actions: Array<[string, string]> = []
    mcpToggle(
      "docs",
      { mcp: [{ key: "docs", source: "global" }] },
      true,
      true,
      (scope, patch) => updates.push([scope, patch]),
      (action, name) => actions.push([action, name]),
    )

    expect(updates).toEqual([["global", { mcp: { docs: { enabled: true } } }]])
    expect(actions).toEqual([])
  })

  it("applies an on-demand disable and invokes disconnect", () => {
    const updates: Array<[string, unknown]> = []
    const actions: Array<[string, string]> = []
    mcpToggle(
      "docs",
      { mcp: [{ key: "docs", source: "global" }] },
      false,
      true,
      (scope, patch) => updates.push([scope, patch]),
      (action, name) => actions.push([action, name]),
    )

    expect(updates).toEqual([["global", { mcp: { docs: { enabled: false } } }]])
    expect(actions).toEqual([["disconnect", "docs"]])
  })

  it("applies an eager enable and invokes connect", () => {
    const updates: Array<[string, unknown]> = []
    const actions: Array<[string, string]> = []
    mcpToggle(
      "docs",
      { mcp: [{ key: "docs", source: "global" }] },
      true,
      false,
      (scope, patch) => updates.push([scope, patch]),
      (action, name) => actions.push([action, name]),
    )

    expect(updates).toEqual([["global", { mcp: { docs: { enabled: true } } }]])
    expect(actions).toEqual([["connect", "docs"]])
  })

  it("applies an eager disable and invokes disconnect", () => {
    const updates: Array<[string, unknown]> = []
    const actions: Array<[string, string]> = []
    mcpToggle(
      "docs",
      { mcp: [{ key: "docs", source: "global" }] },
      false,
      false,
      (scope, patch) => updates.push([scope, patch]),
      (action, name) => actions.push([action, name]),
    )

    expect(updates).toEqual([["global", { mcp: { docs: { enabled: false } } }]])
    expect(actions).toEqual([["disconnect", "docs"]])
  })
})

describe("mcpConfigPatch", () => {
  it("returns project scope and preserves arbitrary partial fields", () => {
    expect(
      mcpConfigPatch("docs", { mcp: [{ key: "docs", source: "project" }] }, { on_demand: true, description: "x" }),
    ).toEqual({ scope: "project", patch: { mcp: { docs: { on_demand: true, description: "x" } } } })
  })

  it("returns global scope for globally defined servers", () => {
    expect(mcpConfigPatch("docs", { mcp: [{ key: "docs", source: "global" }] }, { enabled: false }).scope).toBe(
      "global",
    )
  })

  it("returns no scope for system, default, and unknown servers", () => {
    const collections = {
      mcp: [
        { key: "system", source: "system" as const },
        { key: "default", source: "default" as const },
      ],
    }
    expect(mcpConfigPatch("system", collections, {}).scope).toBeUndefined()
    expect(mcpConfigPatch("default", collections, {}).scope).toBeUndefined()
    expect(mcpConfigPatch("unknown", collections, {}).scope).toBeUndefined()
  })
})

describe("selectedAgentTextOverrideValue", () => {
  it("maps an empty text field value to a null delete sentinel", () => {
    expect(selectedAgentTextOverrideValue("")).toBeNull()
  })

  it("preserves a non-empty text override", () => {
    expect(selectedAgentTextOverrideValue("Review code")).toBe("Review code")
  })
})

describe("selectedAgentNumberOverrideValue", () => {
  it("maps a blank numeric field value to a null delete sentinel", () => {
    expect(selectedAgentNumberOverrideValue("", parseFloat)).toBeNull()
  })

  it("preserves a valid numeric override", () => {
    expect(selectedAgentNumberOverrideValue("0.7", parseFloat)).toBe(0.7)
  })

  it("keeps invalid non-empty numeric input out of the persisted patch", () => {
    expect(selectedAgentNumberOverrideValue("abc", parseFloat)).toBeUndefined()
  })
})

describe("selectedDefaultAgentValue", () => {
  it("maps an empty dropdown value to a null delete sentinel", () => {
    expect(selectedDefaultAgentValue("")).toBeNull()
  })

  it("preserves a non-empty agent selection", () => {
    expect(selectedDefaultAgentValue("code")).toBe("code")
  })
})

describe("shouldClearDefaultAgentWhenAgentBecomesUnavailable", () => {
  it("clears when the current default agent becomes unavailable", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(true, "code", "code")).toBe(true)
  })

  it("does not clear when toggling a non-default agent", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(true, "code", "plan")).toBe(false)
  })

  it("does not clear when the agent remains available", () => {
    expect(shouldClearDefaultAgentWhenAgentBecomesUnavailable(false, "code", "code")).toBe(false)
  })
})
