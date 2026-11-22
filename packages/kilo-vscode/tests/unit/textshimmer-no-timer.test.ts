import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Regression guard for the TextShimmer JS-timer fix.
 *
 * PROBLEM:
 *   A createEffect inside TextShimmer ran clearTimeout + setTimeout on
 *   every `active` prop change. During LLM token streaming, active props
 *   (bound to `pending()` / `running()` accessors) thrashed, firing the
 *   effect thousands of times per second. CPU profile of a 7s streaming
 *   window showed ~2,500 timer operations (~16% of blocked time).
 *
 * FIX:
 *   Drop the effect and the `run` signal. Gate the CSS animation directly
 *   on the `data-active` attribute. The opacity transition on the shimmer
 *   char already handles the fade over `--text-shimmer-swap` (220ms).
 *
 * This static test fails if someone re-introduces the timer pattern.
 */
describe("TextShimmer JS-timer regression guard", () => {
  const tsxPath = join(__dirname, "..", "..", "..", "ui", "src", "components", "text-shimmer.tsx")
  const cssPath = join(__dirname, "..", "..", "..", "ui", "src", "components", "text-shimmer.css")
  // Strip single-line (// ...), block (/* ... */), and JSX block ({/* ... */})
  // comments so assertions ignore explanatory prose and only match live code.
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")

  const tsx = stripComments(readFileSync(tsxPath, "utf8"))
  const css = stripComments(readFileSync(cssPath, "utf8"))

  it("text-shimmer.tsx does not use setTimeout", () => {
    expect(tsx).not.toMatch(/\bsetTimeout\b/)
  })

  it("text-shimmer.tsx does not use clearTimeout", () => {
    expect(tsx).not.toMatch(/\bclearTimeout\b/)
  })

  it("text-shimmer.tsx has no createEffect (animation is CSS-driven)", () => {
    expect(tsx).not.toMatch(/\bcreateEffect\b/)
  })

  it("text-shimmer.tsx does not render a data-run attribute", () => {
    expect(tsx).not.toMatch(/data-run/)
  })

  it("text-shimmer.tsx renders plain text until an instance has been active", () => {
    expect(tsx).toMatch(/createMemo<boolean>\(\(seen\) => seen \|\| active\(\), false\)/)
    expect(tsx).toMatch(/<Show when=\{shimmer\(\)\} fallback=\{text\(\)\}>/)
  })

  it("text-shimmer.css preserves whitespace for plain inactive labels", () => {
    expect(css).toMatch(/\[data-component="text-shimmer"\]\s*\{[^}]*white-space:\s*pre;/)
  })

  it("text-shimmer.css gates the sweep animation on data-active, not data-run", () => {
    expect(css).not.toMatch(/\[data-run="true"\]/)
    expect(css).toMatch(
      /\[data-component="text-shimmer"\]\[data-active="true"\]\s*\[data-slot="text-shimmer-window"\]\s*\{[^}]*animation-name:\s*text-shimmer-window/,
    )
    expect(css).toMatch(
      /\[data-component="text-shimmer"\]\[data-active="true"\]\s*\[data-slot="text-shimmer-window"\]::after\s*\{[^}]*animation-name:\s*text-shimmer-peak/,
    )
  })

  it("text-shimmer animates only transforms so the sweep stays on the compositor", () => {
    expect(tsx).toMatch(/<span data-slot="text-shimmer-window" data-text=\{text\(\)\}\s*\/>/)
    expect(css).toMatch(/\[data-slot="text-shimmer-window"\]::after\s*\{[^}]*content:\s*attr\(data-text\)/)
    const frames = [...css.matchAll(/@keyframes\s+text-shimmer[\w-]*\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? "")
    expect(frames.length).toBe(2)
    for (const body of frames) {
      const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1])
      expect(props.length).toBeGreaterThan(0)
      expect(props.every((prop) => prop === "transform")).toBe(true)
    }
    // Idle labels keep their structure, so the window must not exist until active.
    expect(css).toMatch(
      /\[data-component="text-shimmer"\]\s*\[data-slot="text-shimmer-window"\]\s*\{\s*display:\s*none;/,
    )
    expect(css).not.toMatch(/background-clip:\s*text/)
    expect(css).not.toMatch(/will-change:\s*background-position/)
  })

  it("the hidden dock pauses the shimmer's ::after together with its window", () => {
    // The bright copy animates on ::after, which `*` does not match. Paused only on
    // the window, the two drift out of phase while the dock is hidden and the first
    // status of a turn shows no sweep.
    const layout = stripComments(
      readFileSync(join(__dirname, "..", "..", "webview-ui", "src", "styles", "chat-layout.css"), "utf8"),
    )
    const rule = layout.match(/([^{}]*)\{\s*animation-play-state:\s*paused\s*!important;\s*\}/)
    expect(rule).not.toBeNull()
    const selectors = (rule?.[1] ?? "").split(",").map((sel) => sel.trim())
    expect(selectors).toContain(".session-dock-state:not([data-active]) .working-indicator *")
    expect(selectors).toContain(".session-dock-state:not([data-active]) .working-indicator *::after")
  })
})
