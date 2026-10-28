import { describe, test, expect } from "bun:test"
import { Client } from "../client.js"
import { Telemetry } from "../telemetry.js"

describe("Telemetry hard-off", () => {
  test("Client.init never constructs a PostHog client", () => {
    Client.init()
    expect(Client.isDisabled()).toBe(true)
    expect(Client.getClient()).toBeNull()
    expect(Client.isEnabled()).toBe(false)
  })

  test("Telemetry.shutdown resolves without a client", async () => {
    await expect(Telemetry.shutdown(50)).resolves.toBeUndefined()
  })
})
