import { it } from "bun:test"
import { fixture } from "../fixtures/run"

it("protects snapshot retries and session favorites/tags provider lifecycles", () =>
  fixture("session-favorites-lifecycle"))
