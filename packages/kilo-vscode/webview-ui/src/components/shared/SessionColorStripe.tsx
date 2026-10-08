// fork_change - new file
import { Show, type Component } from "solid-js"
import { colorCss } from "../../../agent-manager/section-colors"
import { useLocalTabs } from "../../context/local-tabs"

/** Thin left stripe that mirrors the session's tab accent in list rows. */
export const SessionColorStripe: Component<{ sessionID: string; color?: string }> = (props) => {
  const tabs = useLocalTabs()
  const color = () => colorCss(props.color ?? tabs?.sessionColor(props.sessionID) ?? null)

  return (
    <Show when={color()}>
      {(value) => <span data-slot="session-color-stripe" style={{ background: value() }} aria-hidden="true" />}
    </Show>
  )
}
