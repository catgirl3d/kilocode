import { describe, expect, it } from "bun:test"
import { createModelSelector } from "../../webview-ui/src/context/session-model-selector"

describe("model selector", () => {
  it("carries the active session variant for the selected model", () => {
    const selected = { providerID: "kilo", modelID: "old" }
    const next: Array<{ id: string; agent: string; selection: typeof selected }> = []
    const variants: Array<{ value: string | undefined; session: string | undefined }> = []
    const hidden: string[] = []
    const selector = createModelSelector({
      current: () => "session",
      agent: () => "code",
      selected: () => selected,
      variant: () => "high",
      apply: (agent, selection, id) => next.push({ id, agent, selection }),
      set: () => undefined,
      carry: (_selection, value, _agent, session) => variants.push({ value, session }),
      hide: (id) => hidden.push(id),
    })

    selector.select("kilo", "new")

    const model = { providerID: "kilo", modelID: "new" }
    expect(next).toEqual([{ id: "session", agent: "code", selection: model }])
    expect(variants).toEqual([{ value: "high", session: "session" }])
    expect(hidden).toEqual(["session"])
  })

  it("allocates a session model without persisting a shared pick", () => {
    const selected = { providerID: "kilo", modelID: "old" }
    const models: Array<{ id: string; agent: string; selection: typeof selected }> = []
    const variants: Array<{ value: string | undefined; session: string | undefined }> = []
    const selector = createModelSelector({
      current: () => "session",
      agent: () => "code",
      selected: () => selected,
      variant: () => "high",
      apply: () => undefined,
      set: (id, agent, selection) => models.push({ id, agent, selection }),
      carry: (_selection, value, _agent, session) => variants.push({ value, session }),
      hide: () => undefined,
    })

    selector.session("session", "kilo", "new")

    const model = { providerID: "kilo", modelID: "new" }
    expect(models).toEqual([{ id: "session", agent: "code", selection: model }])
    expect(variants).toEqual([{ value: "high", session: "session" }])
  })

  it("passes temporary model overrides without remembering them", () => {
    const selected = { providerID: "kilo", modelID: "old" }
    const applied: typeof selected[] = []
    const set: Array<{ id: string; agent: string; selection: typeof selected }> = []
    const variants: Array<{ selection: typeof selected; value: string | undefined }> = []
    const hidden: string[] = []
    const selector = createModelSelector({
      current: () => "session",
      agent: () => "code",
      selected: () => selected,
      variant: () => "high",
      apply: (_agent, selection) => applied.push(selection),
      set: (id, agent, selection) => set.push({ id, agent, selection }),
      carry: (selection, value) => variants.push({ selection, value }),
      hide: (id) => hidden.push(id),
    })

    selector.select("kilo", "new", undefined, false)

    expect(applied).toEqual([])
    expect(set).toEqual([{ id: "session", agent: "code", selection: { providerID: "kilo", modelID: "new" } }])
    expect(variants).toEqual([])
    expect(hidden).toEqual([])
  })
})
