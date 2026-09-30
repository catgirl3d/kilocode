import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import { tmpdir } from "./fixture/tmpdir"

function run(command: string, cwd: string, home: string) {
  const bin = which("bash")
  if (!bin) throw new Error("Bash is required for shell argument regression tests")
  return spawnSync(bin, Shell.args(bin, command, cwd), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HOME: home, BASH_ENV: "", ENV: "" },
    timeout: 15_000,
    windowsHide: true,
  })
}

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  test("preserves Bash assignments before reading assigned values", async () => {
    const tmp = await tmpdir()
    const cwd = path.join(tmp.path, "bash's working directory")
    const home = path.join(tmp.path, "home")

    try {
      await Promise.all([mkdir(cwd), mkdir(home)])
      const result = run(
        `bgprobe=(background bash); bgvalue=assigned; printf 'array=<%s> count=<%s> scalar=<%s>\\n' "\${bgprobe[*]}" "\${#bgprobe[@]}" "$bgvalue"`,
        cwd,
        home,
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe("array=<background bash> count=<2> scalar=<assigned>\n")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  test("preserves Bash command text, cwd, and positional arguments", async () => {
    const tmp = await tmpdir()
    const cwd = path.join(tmp.path, "bash's working directory")
    const home = path.join(tmp.path, "home")
    const command =
      `value='single'\\''quote "double" \\backslash $HOME \`printf backtick\` $(printf substituted)\nnextline'; ` +
      `printf 'payload=<%s>\\nargv0=<%s>\\nargc=<%s>\\narg1=<%s>\\narg2=<%s>\\nargs=<%s>\\n' "$value" "$0" "$#" "$1" "\${2-absent}" "$@"; ` +
      `printf 'cwd-ok\\n' > ./shell-args-cwd.txt`

    try {
      await Promise.all([mkdir(cwd), mkdir(home)])
      const result = run(command, cwd, home)

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(
        `payload=<single'quote "double" \\backslash $HOME \`printf backtick\` $(printf substituted)\nnextline>\n` +
          `argv0=<kilo>\nargc=<1>\narg1=<${cwd}>\narg2=<absent>\nargs=<${cwd}>\n`,
      )
      expect(await Bun.file(path.join(cwd, "shell-args-cwd.txt")).text()).toBe("cwd-ok\n")
    } finally {
      await tmp[Symbol.asyncDispose]()
    }
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
