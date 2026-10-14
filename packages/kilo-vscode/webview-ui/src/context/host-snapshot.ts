// fork_change - new file
import { onCleanup } from "solid-js"
import type { ExtensionMessage } from "../types/messages"

type Options = {
  request: () => void
  ready: () => boolean
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
  delay?: number
}

// Request the host snapshot immediately; retry once after the fallback delay
// and once when extensionDataReady fires while the snapshot is still missing.
export function requestSnapshot(options: Options): void {
  const delay = options.delay ?? 3000
  options.request()
  const fallback = setTimeout(() => {
    if (!options.ready()) options.request()
  }, delay)
  const stop = options.onMessage((message) => {
    if (message.type !== "extensionDataReady") return
    stop()
    clearTimeout(fallback)
    if (!options.ready()) options.request()
  })
  onCleanup(() => {
    stop()
    clearTimeout(fallback)
  })
}
