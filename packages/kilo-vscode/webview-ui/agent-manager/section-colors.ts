// fork_change start - [fork] fixed-swatch 17-color palette with shared menu-grid order
type SectionColor = {
  label: string
  css: string
  random?: boolean
}

/**
 * Section color palette. Fixed hex values stay readable on both light and dark themes.
 * Order drives the shared menu grid: the first eight colors fill the first row next to
 * the "no color" swatch, and the remaining nine fill the second row.
 */
export const SECTION_COLORS: readonly SectionColor[] = [
  { label: "Red", css: "#e5534b" },
  { label: "Orange", css: "#d9822b" },
  { label: "Yellow", css: "#d8b13c" },
  { label: "Green", css: "#2eb872" },
  { label: "Cyan", css: "#29b8db" },
  { label: "Blue", css: "#4a9ef7" },
  { label: "Purple", css: "#b180d7" },
  { label: "Magenta", css: "#c94ec9" },
  { label: "Coral", css: "#f2836b" },
  { label: "Brown", css: "#a06a3e" },
  { label: "Lime", css: "#84cc16" },
  { label: "Teal", css: "#14b8a6" },
  { label: "Indigo", css: "#6366f1" },
  { label: "Pink", css: "#f07ab8" },
  { label: "Gray", css: "#8b949e" },
  { label: "DarkGray", css: "#59636e" },
  { label: "White", css: "#ffffff", random: false },
]

/** Map a stored color label to its CSS color string. Returns undefined for null/unknown labels. */
export function colorCss(label: string | null): string | undefined {
  if (!label) return undefined
  return SECTION_COLORS.find((c) => c.label === label)?.css
}

/** Pick a random color label for new sections, skipping swatches marked as non-random. */
export function randomColor(): string {
  const pool = SECTION_COLORS.filter((color) => color.random !== false)
  return pool[Math.floor(Math.random() * pool.length)]!.label
}
// fork_change end
