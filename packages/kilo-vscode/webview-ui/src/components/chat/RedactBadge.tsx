// fork_change - new file
import { Show, createMemo, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import * as RedactNotice from "../../utils/redact-notice"

/**
 * Says that secrets in text sent to the model are hidden, or sent while the protection is
 * off. The chat shows saved history, which keeps the original keys, so this is the only sign.
 */
export const RedactBadge: Component<{ texts: string[]; variant: "message" | "prompt"; align?: "end" }> = (props) => {
  const config = useConfig()
  const language = useLanguage()
  const keys = createMemo(() => RedactNotice.count(props.texts))
  const on = createMemo(() => RedactNotice.redacting(config.globalEffectiveConfig()))
  const label = () =>
    language.t(`${props.variant === "prompt" ? "prompt" : "chat"}.redact.${on() ? "hidden" : "sent"}`, {
      count: keys(),
    })
  return (
    <Show when={keys() > 0}>
      <div
        data-component="redact-badge"
        data-variant={props.variant}
        data-align={props.align}
        data-off={on() ? undefined : ""}
        role={props.variant === "prompt" ? "status" : undefined}
      >
        <Icon name={on() ? "shield" : "warning"} size="small" />
        <span>{label()}</span>
      </div>
    </Show>
  )
}
