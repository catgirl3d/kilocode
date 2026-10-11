/**
 * PromptSelectors - agent, model, and reasoning as one split control.
 *
 * A layout shell shared by the chat prompt and the Agent Manager New Worktree
 * dialog. Callers pass their existing selectors as slots, so each popover,
 * slash command, and keyboard shortcut keeps its own code path. The shell adds:
 * - Left and Right arrows move focus between segments.
 * - Reasoning collapses before the agent or model name truncates
 *   (`data-tight`), and a changed reasoning value peeks out for a moment
 *   (`data-peek`).
 */

import { type Component, type JSX, onCleanup, onMount } from "solid-js"
import { reserve } from "./prompt-fold"

interface Props {
  agent?: JSX.Element
  model?: JSX.Element
  variant?: JSX.Element
}

const TRIGGER = "[data-slot='popover-trigger']"
const PEEK = 1500

function triggers(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(`.prompt-selector ${TRIGGER}`)).filter(
    (el) => !el.disabled,
  )
}

/**
 * Width a label needs beyond the width it has now (0 when it is not
 * truncated). A label that truncates at its segment's max-width (the agent
 * cap) cannot use more room, so only the part below the cap counts.
 */
function cut(el: HTMLElement | null) {
  if (!el) return 0
  const over = Math.max(0, el.scrollWidth - el.clientWidth)
  const button = el.closest<HTMLElement>(TRIGGER)
  const max = button ? getComputedStyle(button).maxWidth : ""
  if (!button || !max.endsWith("px")) return over
  return Math.max(0, Math.min(over, parseFloat(max) - button.getBoundingClientRect().width))
}

/**
 * True when the control with full labels does not fit. The room is the
 * control width now plus the free space in the toolbar. It does not change
 * when the reasoning label collapses, so the result cannot oscillate.
 *
 * While prompt actions are folded, the room is capped to the space the fold
 * keeps for the control. At each fold step the control gets exactly that
 * space, and only the space between two steps is larger. Without the cap the
 * label would show in that space and collapse again when the next action
 * unfolds. With the cap the order is the same in both directions: actions
 * unfold first, then the reasoning label shows.
 */
function tight(root: HTMLElement) {
  const level = root.querySelector<HTMLElement>(".thinking-selector-trigger-label")
  const hint = root.parentElement
  if (!level || !hint) return false
  const button = level.parentElement
  const gap = button ? parseFloat(getComputedStyle(button).columnGap) || 0 : 0
  const used = level.getBoundingClientRect().width + gap + (parseFloat(getComputedStyle(level).marginInlineEnd) || 0)
  const box = getComputedStyle(hint)
  const inner = hint.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight)
  const others = Array.from(hint.children).reduce(
    (sum, el) => sum + (el === root ? 0 : el.getBoundingClientRect().width),
    0,
  )
  const gaps = (parseFloat(box.columnGap) || 0) * Math.max(0, hint.children.length - 1)
  const width = root.getBoundingClientRect().width
  const free = Math.max(0, inner - gaps - others - width)
  const folded = !!hint.querySelector(".prompt-input-hint-actions > .prompt-action:first-child:not([data-folded])")
  const room = folded ? Math.min(width + free, reserve(hint)) : width + free
  const labels =
    cut(root.querySelector(".mode-switcher-trigger-label")) + cut(root.querySelector(".model-selector-trigger-label"))
  const need = width - used + labels + level.scrollWidth + gap
  return need > room + 1
}

export const PromptSelectors: Component<Props> = (props) => {
  let root: HTMLDivElement | undefined

  onMount(() => {
    const el = root
    if (!el) return
    const state = {
      frame: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      label: null as Element | null,
    }
    const fit = () => {
      state.frame = 0
      el.toggleAttribute("data-tight", tight(el))
    }
    const schedule = () => {
      if (!state.frame) state.frame = requestAnimationFrame(fit)
    }
    const peek = () => {
      const label = el.querySelector(".thinking-selector-trigger-label")
      const prev = state.label
      state.label = label
      if (!label || !prev || label === prev) return
      el.setAttribute("data-peek", "")
      clearTimeout(state.timer)
      state.timer = setTimeout(() => el.removeAttribute("data-peek"), PEEK)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(el)
    if (el.parentElement) {
      resize.observe(el.parentElement)
      for (const child of Array.from(el.parentElement.children)) resize.observe(child)
    }
    const mutation = new MutationObserver(() => {
      peek()
      schedule()
    })
    mutation.observe(el, { childList: true, subtree: true, characterData: true })
    state.label = el.querySelector(".thinking-selector-trigger-label")
    schedule()
    onCleanup(() => {
      resize.disconnect()
      mutation.disconnect()
      clearTimeout(state.timer)
      cancelAnimationFrame(state.frame)
    })
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (!root || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return
    const list = triggers(root)
    const idx = list.indexOf(e.target as HTMLButtonElement)
    if (idx < 0) return
    e.preventDefault()
    const step = e.key === "ArrowLeft" ? -1 : 1
    list[(idx + step + list.length) % list.length]?.focus()
  }

  // fork_change start
  return (
    <div class="prompt-selectors" ref={root} onKeyDown={onKeyDown}>
      {/* fork_change end */}
      <div class="prompt-selector" data-part="agent">
        {props.agent}
      </div>
      <div class="prompt-selector" data-part="model">
        {props.model}
      </div>
      <div class="prompt-selector" data-part="variant">
        {props.variant}
      </div>
    </div>
  )
}
