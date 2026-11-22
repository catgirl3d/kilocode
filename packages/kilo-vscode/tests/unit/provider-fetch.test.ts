import { describe, expect, it } from "bun:test"
import { createProviderFetch } from "../../src/services/cli-backend/provider-fetch"

const client = {}

describe("createProviderFetch", () => {
  it("shares one in-flight request per directory", async () => {
    const fetch = createProviderFetch()
    let calls = 0
    const gate = Promise.withResolvers<void>()
    const load = async () => {
      calls += 1
      await gate.promise
      return { models: ["a"] }
    }

    const first = fetch.read(client, "/repo", load)
    const second = fetch.read(client, "/repo", load)
    gate.resolve()
    const [a, b] = await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(a).toBe(b)
  })

  it("keeps different directories separate", async () => {
    const fetch = createProviderFetch()
    let calls = 0
    const load = async () => {
      calls += 1
      return calls
    }

    const [a, b] = await Promise.all([fetch.read(client, "/a", load), fetch.read(client, "/b", load)])

    expect(calls).toBe(2)
    expect(a).toBe(1)
    expect(b).toBe(2)
  })

  it("starts a new request after the previous one settles", async () => {
    const fetch = createProviderFetch()
    let calls = 0
    const load = async () => {
      calls += 1
      return calls
    }

    expect(await fetch.read(client, "/repo", load)).toBe(1)
    expect(await fetch.read(client, "/repo", load)).toBe(2)
    expect(calls).toBe(2)
  })

  it("clears the in-flight entry when the request rejects", async () => {
    const fetch = createProviderFetch()
    let calls = 0
    const load = async () => {
      calls += 1
      if (calls === 1) throw new Error("boom")
      return "ok"
    }

    await expect(fetch.read(client, "/repo", load)).rejects.toThrow("boom")
    expect(await fetch.read(client, "/repo", load)).toBe("ok")
    expect(calls).toBe(2)
  })

  it("does not hand a new client the request of a previous one", async () => {
    const fetch = createProviderFetch()
    const gate = Promise.withResolvers<void>()
    const old = fetch.read({}, "/repo", async () => {
      await gate.promise
      return "old"
    })
    const next = fetch.read(client, "/repo", async () => "new")

    expect(await next).toBe("new")
    gate.resolve()
    expect(await old).toBe("old")
  })

  it("starts a new request after a reset instead of joining one that began before it", async () => {
    const fetch = createProviderFetch()
    const gate = Promise.withResolvers<void>()
    const stale = fetch.read(client, "/repo", async () => {
      await gate.promise
      return "stale"
    })
    fetch.reset()
    const fresh = fetch.read(client, "/repo", async () => "fresh")
    const joined = fetch.read(client, "/repo", async () => "extra")

    expect(await fresh).toBe("fresh")
    expect(await joined).toBe("fresh")
    gate.resolve()
    expect(await stale).toBe("stale")
  })
})
