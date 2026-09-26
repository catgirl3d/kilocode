import { test, expect } from "bun:test"
import { Effect } from "effect"
import { rm } from "node:fs/promises"
import path from "path"
import { Snapshot } from "../../src/snapshot"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

function run<A>(body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(Snapshot.Service.use(body).pipe(Effect.provide(Snapshot.defaultLayer)))
}

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

const countExcludeResolutions = async (trace: string) => {
  const text = await Bun.file(trace)
    .text()
    .catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.includes('"event":"start"') && line.includes("info/exclude")).length
}

test(
  "exclude path resolves once and follows file creation and deletion",
  async () => {
    await using tmp = await tmpdir({ git: true })
    const exclude = `${tmp.path}/.git/info/exclude`
    const trace = `${tmp.path}-exclude-trace.jsonl`
    await rm(trace, { force: true })
    await rm(exclude, { force: true })
    process.env.GIT_TRACE2_EVENT = trace.replaceAll("\\", "/")
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: () =>
          run((snapshot) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Filesystem.write(`${tmp.path}/ignored.txt`, "v1"))
              const before = yield* snapshot.track()
              expect(before).toBeTruthy()

              yield* Effect.promise(() => Filesystem.write(exclude, "ignored.txt\n"))
              yield* Effect.promise(() => Filesystem.write(`${tmp.path}/ignored.txt`, "v2"))
              const after = yield* snapshot.track()
              expect(after).toBeTruthy()
              expect((yield* snapshot.patch(before!, after!)).files).not.toContain(fwd(tmp.path, "ignored.txt"))

              yield* Effect.promise(() => rm(exclude, { force: true }))
              yield* Effect.promise(() => Filesystem.write(`${tmp.path}/ignored.txt`, "v3"))
              const afterDelete = yield* snapshot.track()
              expect(afterDelete).toBeTruthy()
              expect((yield* snapshot.patch(before!, afterDelete!)).files).toContain(fwd(tmp.path, "ignored.txt"))
            }),
          ),
      })
    } finally {
      delete process.env.GIT_TRACE2_EVENT
    }
    expect(await countExcludeResolutions(trace)).toBe(1)
  },
  { timeout: 35_000 },
)
