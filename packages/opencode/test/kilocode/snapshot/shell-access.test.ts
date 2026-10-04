import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Shell } from "@opencode-ai/core/shell"
import { ShellPermission } from "@/tool/shell"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import path from "path"

const layer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

describe("snapshot shell access", () => {
  it.live(
    "uses the parser path and fails closed for risky read commands",
    () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const permission = yield* ShellPermission
            const shell = Shell.acceptable()
            const read = (command: string, cwd = dir) => permission.snapshotAccess({ command, cwd, shell })

            expect(yield* read("git status")).toBe("read")
            expect(yield* read("git diff")).toBe("unknown")
            expect(yield* read("git diff --no-ext-diff")).toBe("read")
            expect(yield* read("rg command")).toBe("unknown")
            expect(yield* read("rg --no-config command")).toBe("read")
            expect(yield* read("git diff --output=out.txt")).toBe("unknown")
            expect(yield* read("git diff --no-ext-diff --output out.txt")).toBe("unknown")
            expect(yield* read("rg --no-config --pre command")).toBe("unknown")
            expect(yield* read("rg --no-config --pre=./mutator command")).toBe("unknown")
            expect(yield* read("rg --no-config --pre-glob '*.txt' command")).toBe("unknown")
            expect(yield* read("rg --no-config --hostname-bin ./mutator command")).toBe("unknown")
            expect(yield* read("rg --no-config --search-zip command")).toBe("unknown")
            expect(yield* read("git diff > out.txt")).toBe("unknown")
            expect(yield* read("cat package.json")).toBe("unknown")
            expect(yield* read("get-content package.json")).toBe("unknown")
            expect(yield* read("grep command package.json")).toBe("unknown")
            expect(yield* read("git status; git diff")).toBe("unknown")
            expect(yield* read('git status "')).toBe("unknown")
            expect(yield* read("rg command", path.dirname(dir))).toBe("unknown")
          }),
        { git: true },
      ),
    { timeout: 30_000 },
  )
})
