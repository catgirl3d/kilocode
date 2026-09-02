import { unlinkSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { describe, expect, test } from "bun:test"

const root = path.resolve(import.meta.dir, "../..")
const webview = path.join(root, "webview-ui")

describe("consult advisor session store", () => {
  test("delivers mapped part updates to the real session provider and tool card", async () => {
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", webview))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
    }
    const result = await build({
      entryPoints: [path.join(root, "tests/fixtures/consult-advisor-session-store.tsx")],
      bundle: true,
      conditions: ["browser"],
      external: ["happy-dom"],
      format: "esm",
      platform: "node",
      logLevel: "silent",
      loader: { ".css": "empty", ".svg": "text" },
      plugins: [
        {
          name: "solid-dedupe",
          setup(ctx) {
            ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
          },
        },
        {
          name: "pierre-worker-alias",
          setup(ctx) {
            ctx.onResolve({ filter: /pierre\/worker$/ }, (args) => {
              if (args.path.includes("@pierre")) return
              return { path: path.join(root, "webview-ui", "pierre-worker.ts") }
            })
          },
        },
        {
          name: "markdown-worker-url",
          setup(ctx) {
            ctx.onResolve({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
              path: "markdown-worker-url",
              namespace: "test-worker-url",
            }))
            ctx.onLoad({ filter: /.*/, namespace: "test-worker-url" }, () => ({
              contents: "export default 'test-worker.js'",
              loader: "js",
            }))
          },
        },
        solidPlugin(),
      ],
      target: "es2022",
      write: false,
    })
    const file = path.join(root, `.consult-advisor-session-store-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    try {
      const child = Bun.spawnSync([process.execPath, file], { cwd: webview, stdout: "pipe", stderr: "pipe" })
      expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
    } finally {
      unlinkSync(file)
    }
  }, 30_000)
})
