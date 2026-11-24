import { describe, expect, it } from "bun:test"

import { subagentModelPatch } from "../../webview-ui/src/components/shared/subagent-model"

describe("subagentModelPatch", () => {
  it("clears the subagent model and variant", () => {
    expect(subagentModelPatch({ subagent_model: "provider/old", subagent_variant: "high" }, "", "", ["high"])).toEqual({
      subagent_model: null,
      subagent_variant: null,
    })
  })

  it("clears when only the provider is empty", () => {
    expect(subagentModelPatch({ subagent_model: "provider/old" }, "", "model", ["high"])).toEqual({
      subagent_model: null,
      subagent_variant: null,
    })
  })

  it("clears when only the model is empty", () => {
    expect(subagentModelPatch({ subagent_model: "provider/old" }, "provider", "", ["high"])).toEqual({
      subagent_model: null,
      subagent_variant: null,
    })
  })

  it("preserves a compatible variant when switching models", () => {
    expect(
      subagentModelPatch({ subagent_model: "provider/old", subagent_variant: "high" }, "provider", "new", [
        "low",
        "medium",
      ]),
    ).toEqual({
      subagent_model: "provider/new",
      subagent_variant: null,
      subagent_variant_overrides: { "provider/new": "medium" },
    })
  })

  it("clears a stale variant when the new model has no variants", () => {
    expect(
      subagentModelPatch({ subagent_model: "provider/old", subagent_variant: "high" }, "provider", "new", []),
    ).toEqual({ subagent_model: "provider/new", subagent_variant: null })
  })

  it("uses the previous model's override for the compatible variant", () => {
    expect(
      subagentModelPatch(
        {
          subagent_model: "provider/current",
          subagent_variant: "low",
          subagent_variant_overrides: { "provider/current": "high" },
        },
        "provider",
        "next",
        ["low", "high"],
      ),
    ).toEqual({
      subagent_model: "provider/next",
      subagent_variant: null,
      subagent_variant_overrides: { "provider/current": "high", "provider/next": "high" },
    })
  })

  it("writes the selected variant override when reselecting the same model", () => {
    expect(
      subagentModelPatch({ subagent_model: "provider/model", subagent_variant: "high" }, "provider", "model", ["high"]),
    ).toEqual({
      subagent_model: "provider/model",
      subagent_variant_overrides: { "provider/model": "high" },
    })
  })

  it("clears the active variant on a fresh model selection", () => {
    expect(subagentModelPatch({}, "provider", "model", [])).toEqual({
      subagent_model: "provider/model",
      subagent_variant: null,
    })
  })
})
