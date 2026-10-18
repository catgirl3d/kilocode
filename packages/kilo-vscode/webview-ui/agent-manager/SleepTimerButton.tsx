// fork_change - new file
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js"
import { DropdownMenu } from "@kilocode/kilo-ui/dropdown-menu"
import { Icon } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useVSCode } from "../src/context/vscode"
import type { LanguageContextValue } from "../src/context/language"
import type { SleepKind, SleepMode, SleepTimerState } from "../src/types/messages"

export const SleepTimerButton: Component<{ t: LanguageContextValue["t"] }> = (props) => {
  const vscode = useVSCode()
  const [state, setState] = createSignal<SleepTimerState>({ phase: "off", available: false, hibernate: false })
  onCleanup(
    vscode.onMessage((message) => {
      if (message.type === "agentManager.sleepTimer") setState(message)
    }),
  )
  onMount(() => vscode.postMessage({ type: "agentManager.requestSleepTimer" }))
  // Every item but Cancel continues in a host picker. Kobalte returns focus to the button when the
  // menu closes, which pulls it back from the picker into the webview and dismisses the picker.
  const [handoff, setHandoff] = createSignal(false)
  const armed = () => state().mode !== undefined
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const label = () => {
    const value = state()
    if (value.error) return value.error
    if (!value.available) return props.t("agentManager.sleepTimer.unavailable")
    if (value.mode && value.kind === "time" && value.deadline)
      return props.t(`agentManager.sleepTimer.at.${value.mode}`, { time: clock(value.deadline) })
    if (value.phase === "countdown" && value.deadline)
      return props.t("agentManager.sleepTimer.countdown", { time: clock(value.deadline) })
    if (value.mode) return props.t(`agentManager.sleepTimer.armed.${value.mode}`)
    return props.t("agentManager.sleepTimer.toggle")
  }
  const item = (kind: SleepKind, mode: SleepMode) => (
    <DropdownMenu.Item
      disabled={mode === "hibernate" && !state().hibernate}
      onSelect={() => {
        setHandoff(true)
        vscode.postMessage({ type: "agentManager.setSleepTimer", mode, kind })
      }}
    >
      <Icon name={state().mode === mode && state().kind === kind ? "check" : "clock"} size="small" />
      <DropdownMenu.ItemLabel>{props.t(`agentManager.sleepTimer.${kind}.${mode}`)}</DropdownMenu.ItemLabel>
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu gutter={4} placement="bottom-end">
      <Tooltip value={label()} placement="bottom">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="clock"
          size="small"
          variant="ghost"
          aria-label={label()}
          aria-pressed={armed()}
          data-active={state().phase === "countdown" ? "" : undefined}
          disabled={!state().available && !armed()}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="am-split-menu"
          onCloseAutoFocus={(event) => {
            if (!handoff()) return
            event.preventDefault()
            setHandoff(false)
          }}
        >
          {item("agents", "sleep")}
          {item("agents", "hibernate")}
          <DropdownMenu.Separator />
          {item("time", "sleep")}
          {item("time", "hibernate")}
          <Show when={armed()}>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => vscode.postMessage({ type: "agentManager.setSleepTimer" })}>
              <Icon name="close" size="small" />
              <DropdownMenu.ItemLabel>{props.t("agentManager.sleepTimer.cancel")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
