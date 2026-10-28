import { expect } from "bun:test"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

export type Mutation = {
  id: string
  anchor: string
  replace: string
  file?: string
}

const root = path.resolve(import.meta.dir, "../..")
const webview = path.join(root, "webview-ui")
const source = path.join(webview, "src/components/history/SessionList.tsx")
const output = path.join(os.tmpdir(), "kilo")
const happy = pathToFileURL(Bun.resolveSync("happy-dom", webview)).href

async function compile(name: string, mutation?: Mutation) {
  const text = mutation === undefined ? undefined : await Bun.file(mutation.file ?? source).text()
  let hits = 0
  const parser = (code: string, opts: object, parse: (code: string, opts: object) => unknown) => {
    if (code !== text || mutation === undefined) return parse(code, opts)
    const count = code.split(mutation.anchor).length - 1
    if (count !== 1) throw new Error(`mutation ${mutation.id}: anchor count ${count}`)
    hits++
    return parse(code.replace(mutation.anchor, mutation.replace), opts)
  }
  const solid = path.dirname(Bun.resolveSync("solid-js/package.json", webview))
  const aliases: Record<string, string> = {
    "solid-js": path.join(solid, "dist/solid.js"),
    "solid-js/web": path.join(solid, "web/dist/web.js"),
    "solid-js/store": path.join(solid, "store/dist/store.js"),
  }
  const result = await build({
    entryPoints: [path.join(import.meta.dir, `${name}.tsx`)],
    bundle: true,
    conditions: ["browser"],
    external: ["happy-dom"],
    format: "esm",
    loader: { ".css": "empty", ".svg": "dataurl" },
    logLevel: "silent",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "browser-fixture",
        setup(ctx) {
          ctx.onResolve({ filter: /^happy-dom$/ }, () => ({ path: happy, external: true }))
          ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
          ctx.onResolve({ filter: /pierre\/worker$/ }, (args) =>
            args.path.includes("@pierre") ? undefined : { path: path.join(webview, "pierre-worker.ts") },
          )
          ctx.onResolve({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({
            path: "worker",
            namespace: "fixture",
          }))
          ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export default undefined",
            loader: "js",
          }))
        },
      },
      mutation === undefined ? solidPlugin() : solidPlugin({ babel: { plugins: [{ parserOverride: parser }] } }),
    ],
  })
  if (mutation !== undefined && hits !== 1) throw new Error(`mutation ${mutation.id}: transformed ${hits} files`)
  return result.outputFiles[0]!.contents
}

export async function execute(name: string, mutation?: Mutation) {
  const bundle = await compile(name, mutation)
  mkdirSync(output, { recursive: true })
  const file = path.join(output, `${name}-${mutation?.id ?? "plain"}-${crypto.randomUUID()}.mjs`)
  await Bun.write(file, bundle)
  const child = Bun.spawnSync(["bun", file], { cwd: webview, stdout: "pipe", stderr: "pipe" })
  return { code: child.exitCode ?? 1, output: child.stdout.toString() + child.stderr.toString(), file }
}

export async function fixture(name: string) {
  const result = await execute(name)
  expect(result.code, result.output).toBe(0)
}
