import { expect, test } from "bun:test"
import * as EventJournal from "../../src/kilocode/event-journal"

test("journaling is enabled by default and disabled only by an explicit opt-out", () => {
  const previous = process.env.KILO_EVENT_JOURNAL
  try {
    delete process.env.KILO_EVENT_JOURNAL
    expect(EventJournal.enabled()).toBe(true)

    process.env.KILO_EVENT_JOURNAL = "on"
    expect(EventJournal.enabled()).toBe(true)

    process.env.KILO_EVENT_JOURNAL = "off"
    expect(EventJournal.enabled()).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.KILO_EVENT_JOURNAL
    else process.env.KILO_EVENT_JOURNAL = previous
  }
})
