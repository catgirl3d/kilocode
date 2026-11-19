import { describe, expect, test } from "bun:test"
import path from "path"
import { parse, type ParseError } from "jsonc-parser"
import { migrateTuiConfig } from "../../../src/config/tui-migrate"
import { tmpdir } from "../../fixture/fixture"

describe("TUI config migration", () => {
  test("migration keeps kilo.jsonc valid when the moved keys end with a trailing comma", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "kilo.jsonc")
    await Bun.write(
      file,
      `{
  "theme": "dark",
  "keybinds": { "leader": "ctrl+x" },
}
`,
    )

    await migrateTuiConfig({ cwd: tmp.path, directories: [] })

    const errors: ParseError[] = []
    const cfg = parse(await Bun.file(file).text(), errors, { allowTrailingComma: true })
    expect(errors).toEqual([])
    expect(cfg).toEqual({})

    const tui = JSON.parse(await Bun.file(path.join(tmp.path, "tui.json")).text())
    expect(tui.theme).toBe("dark")
  })
})
