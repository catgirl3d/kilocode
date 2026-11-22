import { describe, it } from "bun:test"
import { fixture } from "../fixtures/run"

describe("ProviderProvider retry", () => {
  it("stops retrying after an empty catalog has loaded", () => fixture("provider-retry"), 120_000)
})
