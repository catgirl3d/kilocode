// fork_change - new file
const PRESETS = [5, 15, 30, 60, 120]
const MAX = 24 * 60

export function label(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`
  return minutes === 1 ? "1 minute" : `${minutes} minutes`
}

/** Presets with the previously used value first. */
export function choices(last: number): number[] {
  return [last, ...PRESETS.filter((minutes) => minutes !== last)]
}

/** A stored value is only trusted when it would pass the same check as typed input. */
export function sane(value: unknown): value is number {
  return typeof value === "number" && check(String(value)) === undefined
}

/** Validation message for a typed number of minutes, undefined when it is fine. */
export function check(text: string): string | undefined {
  const value = Number(text.trim())
  if (text.trim() && Number.isInteger(value) && value >= 1 && value <= MAX) return undefined
  return `Enter a whole number of minutes from 1 to ${MAX}`
}
