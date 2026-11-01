import { afterEach, describe, expect, test } from "bun:test"
import {
  CatalogProvider,
  OPENDESIGN_ID,
  OpenDesignAuthPlugin,
  listed,
  opendesignURL,
  overlay,
} from "../../src/kilocode/provider/opendesign"

const saved = process.env.OPENDESIGN_BASE_URL

afterEach(() => {
  if (saved === undefined) delete process.env.OPENDESIGN_BASE_URL
  else process.env.OPENDESIGN_BASE_URL = saved
})

describe("opendesignURL", () => {
  const stored = { type: "api", metadata: { baseURL: "https://stored.test/v1" } }

  test("uses the URL saved by the Connect dialog when nothing else is set", () => {
    delete process.env.OPENDESIGN_BASE_URL
    expect(opendesignURL(undefined, stored)).toBe("https://stored.test/v1")
  })

  test("prefers env over the saved URL, and config over both", () => {
    process.env.OPENDESIGN_BASE_URL = "https://env.test/v1"
    expect(opendesignURL(undefined, stored)).toBe("https://env.test/v1")
    expect(opendesignURL("https://config.test/v1", stored)).toBe("https://config.test/v1")
  })

  test("returns nothing without a configured endpoint", () => {
    delete process.env.OPENDESIGN_BASE_URL
    expect(opendesignURL(undefined, undefined)).toBeUndefined()
    expect(opendesignURL(undefined, { type: "oauth" })).toBeUndefined()
  })
})

describe("provider list", () => {
  test("adds OpenDesign to a catalog that does not have it", () => {
    const base = { other: { id: "other", name: "Other", env: [], models: {} } }
    const out = overlay(base)
    expect(Object.keys(out)).toEqual(["other", OPENDESIGN_ID])
    expect(out[OPENDESIGN_ID]).toBe(CatalogProvider)
  })

  test("keeps an existing OpenDesign catalog entry", () => {
    const existing = { id: OPENDESIGN_ID, name: "Custom", env: [], models: {} }
    expect(overlay({ [OPENDESIGN_ID]: existing })[OPENDESIGN_ID]).toBe(existing)
  })

  test("only exempts OpenDesign from the empty-provider filter", () => {
    expect(listed(OPENDESIGN_ID)).toBe(true)
    expect(listed("apertis")).toBe(false)
  })
})

describe("OpenDesignAuthPlugin", () => {
  test("asks for the base URL alongside the API key", async () => {
    delete process.env.OPENDESIGN_BASE_URL
    const hooks = await OpenDesignAuthPlugin()
    expect(hooks.auth?.provider).toBe(OPENDESIGN_ID)
    const method = hooks.auth?.methods.at(0)
    expect(method?.type).toBe("api")
    expect(method?.prompts?.map((prompt) => prompt.key)).toEqual(["baseURL"])
  })

  test("skips the base URL prompt when OPENDESIGN_BASE_URL is set", async () => {
    process.env.OPENDESIGN_BASE_URL = "https://env.test/v1"
    const hooks = await OpenDesignAuthPlugin()
    expect(hooks.auth?.methods.at(0)?.prompts).toEqual([])
  })
})
