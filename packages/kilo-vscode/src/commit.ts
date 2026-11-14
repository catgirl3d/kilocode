// fork_change - new file
// Short hash of the commit this build was made from. esbuild.js injects it as
// KILO_COMMIT; it stays empty when the code runs unbundled (unit tests).
declare const KILO_COMMIT: string | undefined

export const commit = typeof KILO_COMMIT === "string" ? KILO_COMMIT : ""
