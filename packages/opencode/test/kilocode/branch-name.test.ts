import { describe, expect, test } from "bun:test"
import { messages, parse } from "../../src/kilocode/branch-name"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

function user(text: string, synthetic = false): MessageV2.WithParts {
  const sessionID = SessionID.make("ses_branch_name_test")
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: {
        providerID: ProviderV2.ID.make("kilo"),
        modelID: ModelV2.ID.make("kilo-auto/small"),
      },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID,
        type: "text",
        text,
        synthetic,
      },
    ],
  }
}

describe("branch name generation helpers", () => {
  test("builds a typed branch name from model output", () => {
    expect(parse("fix/token-refresh-race")).toBe("fix/token-refresh-race")
    expect(parse("feat/billing-alerts")).toBe("feat/billing-alerts")
    expect(parse("docs/config-schema")).toBe("docs/config-schema")
    expect(parse("  Fix OAuth / Token Refresh!  ")).toBe("fix/oauth-token-refresh")
  })

  test("converts a legacy flat name when the first word is a known type", () => {
    expect(parse("fix-token-refresh-race")).toBe("fix/token-refresh-race")
    expect(parse("refactor-auth-store")).toBe("refactor/auth-store")
  })

  test("flattens unknown or untyped names", () => {
    expect(parse("feature")).toBe("feature")
    expect(parse("wip/foo")).toBe("wip-foo")
    expect(parse("fix/a/b")).toBe("fix/a-b")
    expect(parse("add-health-check-endpoint")).toBe("add-health-check-endpoint")
  })

  test("rejects an empty slug after a known type", () => {
    expect(parse("fix/")).toBeNull()
    expect(parse("null")).toBeNull()
    expect(parse("!!!")).toBeNull()
  })

  test("rejects repeated null sentinels", () => {
    expect(parse("null")).toBeNull()
    expect(parse("nullnull")).toBeNull()
    expect(parse("NULL null")).toBeNull()
    expect(parse(" nullnull ")).toBeNull()
    expect(parse("null-null")).toBeNull()
    expect(parse("null, null")).toBeNull()
    expect(parse("null/null")).toBeNull()
    expect(parse("nullnull.")).toBeNull()
    expect(parse('" nullnull "')).toBeNull()
    expect(parse("fix/null-null")).toBeNull()
  })

  test("keeps null-like words inside real names", () => {
    expect(parse("null-pointer")).toBe("null-pointer")
    expect(parse("fix/null-pointer")).toBe("fix/null-pointer")
    expect(parse("fix-null-pointer")).toBe("fix/null-pointer")
  })

  test("accepts a link reference as a typed name", () => {
    expect(parse("chore/issue-120")).toBe("chore/issue-120")
  })

  test("rejects a pasted link echoed instead of a branch name", () => {
    expect(parse("https://github.com/catgirl3d/SayIt/issues/120")).toBeNull()
    expect(parse("Fix https://github.com/catgirl3d/SayIt/issues/120")).toBeNull()
    expect(parse("github.com/catgirl3d/SayIt/issues/120")).toBeNull()
    expect(parse("www.github.com/catgirl3d/SayIt/issues/120")).toBeNull()
  })

  test("strips code fences and quotes around the name", () => {
    expect(parse("```\nfix/token-refresh-race\n```")).toBe("fix/token-refresh-race")
    expect(parse('"fix/token-refresh-race"')).toBe("fix/token-refresh-race")
  })

  test("trims a long name on a word boundary", () => {
    expect(parse("fix/overlay-ai-indicator-ignoring-resolved-ai-route")).toBe(
      "fix/overlay-ai-indicator-ignoring-resolved-ai",
    )
  })

  test("counts the type prefix against the length limit", () => {
    const typed = parse("refactor/" + "a".repeat(100))
    expect(typed?.startsWith("refactor/")).toBe(true)
    expect(typed?.length).toBeLessThanOrEqual(50)

    const legacy = parse("fix-" + "a".repeat(100))
    expect(legacy?.startsWith("fix/")).toBe(true)
    expect(legacy?.length).toBeLessThanOrEqual(50)
  })

  test("removes reasoning wrappers before parsing", () => {
    expect(parse("<think>Choose a durable outcome</think>\nfix/token-refresh-race")).toBe("fix/token-refresh-race")
    expect(parse("<THINK>Choose a durable outcome</THINK>\nadd-health-check-endpoint")).toBe(
      "add-health-check-endpoint",
    )
  })

  test("uses recent real user messages and appends the pending prompt once", () => {
    const history = [user("hi"), user("internal", true), user("Can you inspect auth?")]
    expect(messages(history, "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix the token refresh race",
    ])
    expect(messages([...history, user("Fix   the token refresh race")], "Fix the token refresh race")).toEqual([
      "hi",
      "Can you inspect auth?",
      "Fix   the token refresh race",
    ])
  })

  test("keeps only the latest four user messages", () => {
    const history = [user("one"), user("two"), user("three"), user("four"), user("five")]
    expect(messages(history, "six")).toEqual(["three", "four", "five", "six"])
  })

  test("truncates large messages before generation", () => {
    const big = "x".repeat(2_000)

    expect(messages([user(big)], big)).toEqual(["x".repeat(1_000)])
  })
})
