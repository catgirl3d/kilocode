// fork_change - new file
import { existsSync } from "node:fs"
import { join } from "node:path"
import { exec } from "../../util/process"

export type SleepMode = "sleep" | "hibernate"

export interface PowerDriver {
  readonly available: boolean
  readonly reason?: string
  /** Whether the platform can hibernate at all. */
  readonly hibernate: boolean
  /** Describes why a mode cannot work, so arming fails before anyone walks away. */
  check(mode: SleepMode): Promise<string | undefined>
  run(mode: SleepMode): Promise<void>
}

type Run = typeof exec

function detail(err: unknown): string {
  if (err instanceof Error && "stderr" in err && typeof err.stderr === "string" && err.stderr.trim())
    return err.stderr.trim()
  return err instanceof Error ? err.message : String(err)
}

// rundll32 powrprof.dll,SetSuspendState does not marshal its arguments and
// hibernates when hibernation is on, so call the API directly.
function script(hibernate: boolean): string {
  return `$ErrorActionPreference = 'Stop'
$type = Add-Type -MemberDefinition '[DllImport("powrprof.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.U1)] public static extern bool SetSuspendState(bool hibernate, bool force, bool disableWakeEvent);' -Name 'KiloPower' -Namespace 'Kilo' -PassThru
if (-not $type::SetSuspendState($${hibernate}, $false, $false)) { throw 'SetSuspendState failed' }`
}

export function createPowerDriver(
  opts: { reason?: string; platform?: NodeJS.Platform; exec?: Run; exists?: (path: string) => boolean } = {},
): PowerDriver {
  const platform = opts.platform ?? process.platform
  const run = opts.exec ?? exec
  const exists = opts.exists ?? existsSync
  const systemctl = ["/usr/bin/systemctl", "/bin/systemctl"].find(exists)
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const unsupported = !["darwin", "linux", "win32"].includes(platform)
    ? `Sleep timer is not supported on ${platform}`
    : undefined
  const reason =
    opts.reason ??
    unsupported ??
    (platform === "linux" && !systemctl ? "The systemctl command is not available" : undefined)

  function command(mode: SleepMode): [string, string[]] {
    if (platform === "darwin") return ["/usr/bin/pmset", ["sleepnow"]]
    if (platform === "linux") return [systemctl ?? "systemctl", [mode === "hibernate" ? "hibernate" : "suspend"]]
    return [
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script(mode === "hibernate")],
    ]
  }

  return {
    available: !reason,
    reason,
    hibernate: platform !== "darwin",
    async check(mode) {
      if (mode !== "hibernate" || platform !== "win32") return undefined
      const out = await run("reg", [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power",
        "/v",
        "HibernateEnabled",
      ]).catch(() => undefined)
      if (!out || !/REG_DWORD\s+0x0\b/.test(out.stdout)) return undefined
      return 'Hibernation is not enabled on this computer. Run "powercfg /hibernate on" in an elevated terminal.'
    },
    async run(mode) {
      if (reason) throw new Error(reason)
      const [cmd, args] = command(mode)
      await run(cmd, args).catch((err: unknown) => {
        throw new Error(detail(err))
      })
    },
  }
}
