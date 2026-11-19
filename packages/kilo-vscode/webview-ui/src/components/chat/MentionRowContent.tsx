// fork_change - new file
import type { JSX } from "solid-js"
import { Icon, type IconProps } from "@kilocode/kilo-ui/icon"

export function MentionRowContent(props: { icon: IconProps["name"]; label: JSX.Element; detail: JSX.Element }) {
  return (
    <>
      <Icon name={props.icon} class="file-mention-icon" />
      <span class="file-mention-name">{props.label}</span>
      <span class="file-mention-dir">{props.detail}</span>
    </>
  )
}
