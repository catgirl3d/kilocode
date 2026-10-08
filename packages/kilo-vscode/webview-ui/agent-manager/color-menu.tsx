// fork_change - new file
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import type { Component } from "solid-js"
import { SECTION_COLORS } from "./section-colors"

/**
 * Shared color palette grid for section and session-tab context menus, so both
 * keep one palette definition, item classes, and active-state behavior.
 */
export const ColorMenuItems: Component<{
  label: string
  color?: string | null
  onSet: (color: string | null) => void
}> = (props) => (
  <ContextMenu.Group>
    <ContextMenu.GroupLabel>{props.label}</ContextMenu.GroupLabel>
    <div class="am-color-grid">
      <ContextMenu.Item onSelect={() => props.onSet(null)} class="am-color-grid-item">
        <span class="am-color-swatch am-color-swatch-default"></span>
      </ContextMenu.Item>
      {SECTION_COLORS.map((c) => (
        <ContextMenu.Item onSelect={() => props.onSet(c.label)} class="am-color-grid-item">
          <span
            class={`am-color-swatch ${props.color === c.label ? "am-color-swatch-active" : ""}`}
            style={{ background: c.css }}
          ></span>
        </ContextMenu.Item>
      ))}
    </div>
  </ContextMenu.Group>
)
