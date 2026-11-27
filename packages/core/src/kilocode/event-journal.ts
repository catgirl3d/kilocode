// kilocode_change - new file
// Durable event journaling is on by default. Set KILO_EVENT_JOURNAL=off to
// keep projectors, `event_sequence`, and live subscribers while skipping the
// append-only `event` row (no replay/sync journal for this machine).
const OFF = new Set(["0", "false", "off", "no"])

export function enabled() {
  return !OFF.has((process.env["KILO_EVENT_JOURNAL"] ?? "").toLowerCase())
}
