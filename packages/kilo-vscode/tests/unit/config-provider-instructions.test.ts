import { describe, expect, it } from "bun:test"
import path from "node:path"

const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")
const PASS = "CONFIG_PROVIDER_INSTRUCTIONS_PASS"
const FAIL = "CONFIG_PROVIDER_INSTRUCTIONS_FAIL:"

const SCRIPT = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node

  const sent = []
  globalThis.acquireVsCodeApi = () => ({
    postMessage: (message) => sent.push(message),
    getState: () => undefined,
    setState: () => {},
  })

  const handlers = new Set()
  const vscode = {
    postMessage: (message) => sent.push(message),
    onMessage: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    getState: () => undefined,
    setState: () => {},
  }
  const { mock } = await import("bun:test")
  mock.module("./src/context/vscode.tsx", () => ({ useVSCode: () => vscode }))

  const { createComponent } = await import("solid-js")
  globalThis.React = {
    createElement: (type, props, ...children) => createComponent(type, { ...props, children: children[0] }),
  }
  const { render } = await import("solid-js/web")
  const { ConfigProvider, useConfig } = await import("./src/context/config.tsx")

  let api
  const Probe = () => {
    api = useConfig()
    return null
  }
  const root = document.createElement("div")
  const dispose = render(
    () => createComponent(ConfigProvider, { get children() { return () => createComponent(Probe, {}) } }),
    root,
  )

  const binding = (id, scope) => ({
    id,
    scope,
    target: {
      scope,
      path: scope === "global" ? "/config/kilo.jsonc" : "/repo/.kilo/kilo.jsonc",
      revision: id + "-revision",
      exists: true,
      writable: true,
      raw: {},
    },
  })
  const loaded = {
    type: "configLoaded",
    config: { instructions: ["global.md", "project.md"] },
    globalConfig: {
      instructions: ["global.md"],
      mcp: { server: { type: "remote", url: "https://example.com/mcp", description: "old", on_demand: true } },
    },
    globalEffectiveConfig: {
      instructions: ["global.md", "project.md"],
      mcp: { server: { type: "remote", url: "https://example.com/mcp", description: "old", on_demand: true } },
    },
    projectConfig: {
      instructions: ["project.md"],
      mcp: { server: { type: "remote", url: "https://project.example/mcp", description: "project", on_demand: true } },
    },
    bindings: { global: binding("global-binding", "global"), project: binding("project-binding", "project") },
    features: { indexing: false, sandboxControls: false },
  }
  handlers.forEach((handler) => handler(loaded))

  if (!api) {
    console.log("${FAIL}provider did not render")
    process.exit(2)
  }
  api.updateGlobalConfig({ instructions_disabled: ["global.md"] })
  api.updateProjectConfig({ instructions_disabled: ["project.md"] })
  api.updateGlobalConfig({ mcp: { server: { url: undefined, description: undefined, enabled: false } } })
  api.updateProjectConfig({ mcp: { server: { url: undefined, description: undefined } } })
  api.saveConfig()

  const updates = sent.filter((message) => message.type === "updateConfig")
  if (updates.length !== 1) {
    console.log("${FAIL}expected one updateConfig message: " + JSON.stringify(sent))
    process.exit(2)
  }
  const update = updates[0]
  if (JSON.stringify(update.config.instructions_disabled) !== JSON.stringify(["global.md"])) {
    console.log("${FAIL}global instruction config leaked or was lost: " + JSON.stringify(update))
    process.exit(2)
  }
  if (JSON.stringify(update.projectConfig.instructions_disabled) !== JSON.stringify(["project.md"])) {
    console.log("${FAIL}project instruction config leaked or was lost: " + JSON.stringify(update))
    process.exit(2)
  }
  if (update.globalBindingId !== "global-binding" || update.projectBindingId !== "project-binding") {
    console.log("${FAIL}binding ids were not preserved: " + JSON.stringify(update))
    process.exit(2)
  }
  if (update.config.mcp?.server?.url !== undefined || update.config.mcp?.server?.description !== undefined) {
    console.log("${FAIL}cleared MCP fields leaked into config: " + JSON.stringify(update))
    process.exit(2)
  }
  if (update.config.mcp?.server?.enabled !== false) {
    console.log("${FAIL}MCP enabled state was not persisted: " + JSON.stringify(update))
    process.exit(2)
  }
  const unset = JSON.stringify(update.globalUnset)
  if (!unset.includes('["mcp","server","url"]') || !unset.includes('["mcp","server","description"]')) {
    console.log("${FAIL}cleared MCP fields were not sent as unset paths: " + JSON.stringify(update))
    process.exit(2)
  }
  const projectUnset = JSON.stringify(update.projectUnset)
  if (!projectUnset.includes('["mcp","server","url"]') || !projectUnset.includes('["mcp","server","description"]')) {
    console.log("${FAIL}project MCP fields were not sent as unset paths: " + JSON.stringify(update))
    process.exit(2)
  }
  dispose()
  console.log("${PASS}")
`

describe("ConfigProvider scoped config persistence", () => {
  it("posts scoped updates with bindings and MCP unset paths", () => {
    const result = Bun.spawnSync(["bun", "--conditions=browser", "-e", SCRIPT], {
      cwd: WEBVIEW,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = result.stdout.toString() + result.stderr.toString()

    if (output.includes(PASS)) return
    const logic = output.indexOf(FAIL)
    if (logic !== -1) {
      expect.unreachable(
        output
          .slice(logic + FAIL.length)
          .split("\n")[0]
          ?.trim(),
      )
    }
    expect.unreachable(`provider child failed with exit ${result.exitCode}: ${output.trim() || "<no output>"}`)
  }, 30_000)
})
