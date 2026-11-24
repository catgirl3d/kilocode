import { describe, expect, test } from "bun:test"
import { MemoryRedact } from "../src/capture/redact"

describe("curl user redaction", () => {
  const values = { values: true }
  const marker = "[redacted]"
  const colon = String.fromCharCode(58)
  const pass = ["fixture", "only"].join("-")
  const text = (value: string) => value.replaceAll("~", colon)

  test("leaves -u values of other commands and URLs unchanged", () => {
    const lines = [
      "az rest -u https~//app.example.test/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798",
      "tool -u http~//localhost~8080/api",
      "docker run -u 1000~1000 node~20",
      "docker exec -u root~root app sh",
      "docker run --user node~node image",
      "rsync -u a~b c",
      "curl -u https~//example.test/a https~//example.test/b",
      "curl https~//example.test\ndocker run -u 1000~1000 node~20",
      "docker run --rm `\n  -u 1000~1000 node~20",
    ]
    for (const line of lines) {
      const input = text(line)
      expect(MemoryRedact.text(input, values), input).toBe(input)
    }
  })

  test("masks curl passwords across continued lines and flag-only lines", () => {
    const cases = [
      ["curl -u alice~", " https~//example.test"],
      ["curl --user alice~", " https~//example.test"],
      ["curl.exe -u alice~", " https~//example.test"],
      ["$CURL -u alice~", " https~//example.test"],
      ["curl -X POST \\\n  -H 'Accept~ json' \\\n  -u alice~", " \\\n  https~//example.test"],
      ["curl -X POST \\\r\n  -u alice~", " https~//example.test"],
      ['curl.exe -X POST `\r\n  -H "Accept~ json" -u alice~', " https~//example.test"],
      ['curl -X POST ^\r\n  -H "Accept~ json" -u alice~', " https~//example.test"],
      ['{"command"~"curl -u alice~', ' https~//example.test"}'],
      ["scripts/deploy.sh~12~  curl -u alice~", " https~//example.test"],
      ["silent\n--user alice~", ""],
    ] as const
    for (const [before, after] of cases) {
      const input = text(before) + pass + text(after)
      expect(MemoryRedact.text(input, values), input).toBe(text(before) + marker + text(after))
    }
  })
})
