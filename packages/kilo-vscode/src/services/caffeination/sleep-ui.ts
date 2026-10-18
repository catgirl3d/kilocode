// fork_change - new file
import * as vscode from "vscode"
import type { CaffeinationService } from "./service"
import { createPowerDriver, type SleepMode } from "./power"
import { check, choices, label, sane } from "./sleep-delay"
import { GRACE, SleepService, type Connection, type SleepControls } from "./sleep"

const KEY = "sleep.confirmed"
const LAST = "sleep.minutes"
const FALLBACK = 30

export function createSleep(
  context: vscode.ExtensionContext,
  connection: Connection,
  awake: Pick<CaffeinationService, "getState" | "setEnabled">,
  reason?: string,
) {
  const service = new SleepService(connection, createPowerDriver({ reason }), {
    // A Linux inhibitor blocks suspend, and Keep Awake has no job once the computer sleeps.
    before: async () => {
      if (awake.getState().enabled) await awake.setEnabled(false)
    },
  })

  const countdown = (mode: SleepMode | undefined, kind: string | undefined, end: number) =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${kind === "agents" ? "Kilo agents are done. " : ""}The computer will ${mode === "hibernate" ? "hibernate" : "sleep"} in`,
        cancellable: true,
      },
      async (progress, token) => {
        const done = Promise.withResolvers<void>()
        const tick = () => progress.report({ message: `${Math.max(0, Math.ceil((end - Date.now()) / 1000))}s` })
        const timer = setInterval(tick, 1000)
        const off = service.onChange((state) => {
          if (state.phase !== "countdown") done.resolve()
        })
        token.onCancellationRequested(() => {
          service.cancel()
          done.resolve()
        })
        tick()
        if (service.getState().phase !== "countdown") done.resolve()
        await done.promise
        clearInterval(timer)
        off()
      },
    )

  // The notification only covers the final minute; a long wait stays quiet.
  let warn: ReturnType<typeof setTimeout> | undefined
  let prior = service.getState()
  const unsubscribe = service.onChange((state) => {
    const before = prior
    prior = state
    if (state.error && state.error !== before.error) {
      void vscode.window.showErrorMessage(`Sleep timer stopped: ${state.error}`)
    }
    if (state.phase !== "countdown" && warn) {
      clearTimeout(warn)
      warn = undefined
    }
    if (state.phase !== "countdown" || before.phase === "countdown") return
    const end = state.deadline ?? Date.now()
    warn = setTimeout(
      () => {
        warn = undefined
        if (service.getState().phase === "countdown") void countdown(state.mode, state.kind, end)
      },
      Math.max(0, end - GRACE - Date.now()),
    )
  })

  const confirm = async (mode: SleepMode) => {
    if (context.globalState.get<boolean>(KEY) === true) return true
    const detail = [
      "When every Kilo session is idle or only waiting for your approval or answer, Kilo shows a one-minute countdown you can cancel, then puts this computer to sleep or hibernation. The timer fires once and is cleared when this VS Code window reloads.",
      "Keep Awake is turned off when the computer goes to sleep, and scheduled agent wakeups count as running work. Unsaved work in other applications is not saved.",
    ].join("\n\n")
    const answer = await vscode.window.showWarningMessage(
      `Put this computer to ${mode === "hibernate" ? "hibernation" : "sleep"} when Kilo agents finish?`,
      { modal: true, detail },
      "Enable Sleep Timer",
    )
    if (answer !== "Enable Sleep Timer") return false
    await context.globalState.update(KEY, true).then(undefined, (error: unknown) => {
      console.warn("[Kilo New] Could not save sleep timer confirmation:", error)
    })
    return true
  }

  const wait = async (mode: SleepMode): Promise<number | undefined> => {
    const stored = context.globalState.get<number>(LAST)
    const last = sane(stored) ? stored : FALLBACK
    const picked = await vscode.window.showQuickPick(
      [
        ...choices(last).map((minutes) => ({
          label: label(minutes),
          description: minutes === last && sane(stored) ? "last used" : undefined,
          minutes,
        })),
        { label: "Custom…", description: undefined, minutes: 0 },
      ],
      {
        title: mode === "hibernate" ? "Hibernate in…" : "Sleep in…",
        placeHolder: "How long from now?",
        ignoreFocusOut: true,
      },
    )
    if (!picked) return undefined
    const text = picked.minutes
      ? String(picked.minutes)
      : await vscode.window.showInputBox({
          title: mode === "hibernate" ? "Hibernate in…" : "Sleep in…",
          prompt: "Minutes from now",
          ignoreFocusOut: true,
          value: String(last),
          validateInput: check,
        })
    if (text === undefined) return undefined
    const minutes = Number(text)
    await context.globalState.update(LAST, minutes).then(undefined, (error: unknown) => {
      console.warn("[Kilo New] Could not save sleep timer delay:", error)
    })
    return minutes
  }

  const controls: SleepControls = {
    getState: () => service.getState(),
    onChange: service.onChange.bind(service),
    set: async (mode, kind) => {
      if (!mode) return service.cancel()
      const verb = mode === "hibernate" ? "hibernate" : "sleep"
      if (kind === "time") {
        const minutes = await wait(mode)
        if (minutes === undefined) return
        await service.schedule(mode, minutes * 60_000)
        if (service.getState().mode === mode) {
          void vscode.window.showInformationMessage(`Sleep timer set. The computer will ${verb} in ${label(minutes)}.`)
        }
        return
      }
      if (!(await confirm(mode))) return
      await service.arm(mode)
      if (service.getState().mode !== mode) return
      void vscode.window.showInformationMessage(`Sleep timer set. The computer will ${verb} when Kilo agents finish.`)
    },
  }

  return {
    controls,
    dispose: () => {
      if (warn) clearTimeout(warn)
      unsubscribe()
      service.dispose()
    },
  }
}
