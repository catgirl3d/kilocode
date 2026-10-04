// Imported FIRST by shared-index-track-guard.test.ts so track.ts module init
// sees inverted budgets: the turn-level guard must fire before the track-level
// wrapper, making `protect` observable separately from `wrap`.
process.env.KILO_SNAPSHOT_TRACK_TIMEOUT_MS = "30000"
process.env.KILO_SNAPSHOT_TURN_TIMEOUT_MS = "5000"
