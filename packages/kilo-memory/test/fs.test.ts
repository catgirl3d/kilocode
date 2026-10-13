import { expect, test } from "bun:test"
import { mkdtemp, open, readFile, readdir, rm } from "fs/promises"
import os from "os"
import path from "path"
import { MemoryFs } from "../src/storage/fs"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function use(fn: (t: { dir: string; file: string }) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kilo-memory-fs-"))
  try {
    await fn({ dir, file: path.join(dir, "index.kmem") })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test.skipIf(process.platform !== "win32")(
  "retries the replacement after a reader blocks the first rename",
  async () => {
    await use(async (t) => {
      await MemoryFs.write(t.file, "v1")
      const handle = await open(t.file, "r")
      const start = Date.now()
      const pending = MemoryFs.write(t.file, "v2").then(
        () => undefined,
        (error: unknown) => error,
      )

      await sleep(250)
      await handle.close()
      const error = await pending
      if (error) throw error

      // The reader holds the file through the first retry delays, so only the last attempt can
      // succeed after close: a fast completion would mean the first rename never collided.
      expect(Date.now() - start).toBeGreaterThanOrEqual(300)
      expect(await readFile(t.file, "utf8")).toBe("v2")
      expect((await readdir(t.dir)).filter((file) => file.endsWith(".tmp"))).toEqual([])
    })
  },
)
