// fork_change - new file
import type { ExtensionMessage } from "../types/messages"
import type { useLanguage } from "./language"
import type { useVSCode } from "./vscode"
import { createSessionReasoning } from "./session-reasoning"
import { createSessionTools } from "./session-tools"

interface Deps {
  isConnected: () => boolean
  currentSessionID: () => string | undefined
  post: ReturnType<typeof useVSCode>["postMessage"]
  language: ReturnType<typeof useLanguage>
}

/** Previewed history clears (reasoning and tool output) behind one message handler and one context surface. */
export function createSessionClears(deps: Deps) {
  const reasoning = createSessionReasoning(deps)
  const tools = createSessionTools(deps)
  return {
    handleMessage: (message: ExtensionMessage) => reasoning.handleMessage(message) || tools.handleMessage(message),
    api: {
      reasoningPreview: reasoning.preview,
      reasoningCancel: reasoning.cancel,
      reasoningClear: reasoning.apply,
      reasoningState: reasoning.state,
      reasoningClearing: (id: string) => reasoning.clearing(id),
      toolPreview: tools.preview,
      toolCancel: tools.cancel,
      toolClear: tools.apply,
      toolState: tools.state,
      toolClearing: (id: string) => tools.clearing(id),
    },
  }
}
