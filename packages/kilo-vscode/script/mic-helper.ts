// fork_change - new file
import { $ } from "bun"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const pkg = "@analyticsinmotion/micstream@0.4.0"
const sha = "83aaa5063d018085fcf519b6e951185ceda7fc94d75678aded2664bf4203fc1a"

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export async function ensureMicForTarget(target: string, bin: string): Promise<void> {
  if (target !== "win32-x64") {
    console.warn(`No WASAPI microphone prebuild for ${target}; speech input will use FFmpeg.`)
    return
  }

  const dest = join(bin, "kilo-mic-win32-x64.node")
  const marker = join(bin, "..", "node_modules", ".kilo-mic-target")
  if (
    existsSync(dest) &&
    existsSync(marker) &&
    (await Bun.file(marker).text()).trim() === target &&
    digest(dest) === sha
  )
    return

  const tmp = join(bin, ".mic-tmp")
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  try {
    const packed = await $`npm pack ${pkg} --pack-destination ${tmp}`.quiet()
    const name = packed.text().trim().split(/\s+/).pop()
    if (!name) throw new Error(`npm pack did not return a tarball for ${pkg}`)

    await $`tar -xzf ${name}`.cwd(tmp).quiet()
    const source = join(tmp, "package", "prebuilds", "win32-x64", "node.napi.node")
    const actual = digest(source)
    if (actual !== sha) throw new Error(`Unexpected WASAPI microphone binary hash: ${actual}`)
    copyFileSync(source, dest)
    await Bun.write(marker, `${target}\n`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
