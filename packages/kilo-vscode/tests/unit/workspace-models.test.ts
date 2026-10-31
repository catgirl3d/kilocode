import { describe, expect, it } from "bun:test"

import { pinned, release, snapshot } from "../../webview-ui/src/components/settings/workspace-models"
import type { Config } from "../../webview-ui/src/types/messages"
import { deepMerge, stripNulls } from "../../webview-ui/src/utils/config-utils"

const config: Config = {
  model: "kilo/anthropic/claude-sonnet-4-6",
  small_model: null,
  subagent_model: "kilo/openai/gpt-5",
  subagent_variant: "high",
  share: "manual",
  experimental: { batch_tool: true, advisor_model: "kilo/openai/gpt-5", advisor_variant: null },
  agent: {
    code: { prompt: "x", model: "kilo/anthropic/claude-haiku" },
    plan: { prompt: "y" },
  },
}

describe("pinned", () => {
  it("is false without workspace model choices", () => {
    const unrelated: Config = { share: "manual", experimental: { batch_tool: true }, agent: { code: { prompt: "x" } } }
    expect(pinned({})).toBe(false)
    expect(pinned(unrelated)).toBe(false)
  })

  it("ignores null model choices", () => {
    expect(pinned({ model: null, experimental: { advisor_model: null } })).toBe(false)
  })

  it("is true for a default, advisor, or mode model", () => {
    expect(pinned({ model: "kilo/anthropic/claude-sonnet-4-6" })).toBe(true)
    expect(pinned({ experimental: { advisor_model: "kilo/openai/gpt-5" } })).toBe(true)
    expect(pinned({ agent: { compaction: { model: "kilo/openai/gpt-5" } } })).toBe(true)
  })

  it("stays pinned when advisors are disabled with an empty list", () => {
    expect(pinned({ experimental: { advisors: [] } })).toBe(true)
  })
})

describe("snapshot", () => {
  it("copies only the model choices that are set", () => {
    expect(snapshot(config)).toEqual({
      model: "kilo/anthropic/claude-sonnet-4-6",
      subagent_model: "kilo/openai/gpt-5",
      subagent_variant: "high",
      experimental: { advisor_model: "kilo/openai/gpt-5" },
      agent: { code: { model: "kilo/anthropic/claude-haiku" } },
    })
  })

  it("omits empty experimental and agent sections", () => {
    const patch = snapshot({ share: "manual", experimental: { batch_tool: true }, agent: { code: { prompt: "x" } } })
    expect(patch).toEqual({})
    expect(patch).not.toHaveProperty("experimental")
    expect(patch).not.toHaveProperty("agent")
  })

  it("produces a patch that pins the workspace", () => {
    expect(pinned(snapshot(config))).toBe(true)
  })
})

describe("release", () => {
  it("nulls only the model choices the workspace defines", () => {
    expect(release(config)).toEqual({
      model: null,
      subagent_model: null,
      subagent_variant: null,
      experimental: { advisor_model: null },
      agent: { code: { model: null } },
    })
  })

  it("returns an empty patch when the workspace defines no model choices", () => {
    expect(release({ share: "manual" })).toEqual({})
  })

  it("leaves the workspace unpinned once applied", () => {
    const project: Config = { model: "kilo/anthropic/claude-sonnet-4-6", experimental: { advisor_model: "a/b" } }
    expect(pinned(stripNulls(deepMerge(project, release(project))))).toBe(false)
  })
})
