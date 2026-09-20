// fork_change - new file
import { createSignal } from "solid-js"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { ExtensionMessage, SessionShakeCompletedMessage } from "../types/messages"
import type { useLanguage } from "./language"
import type { useVSCode } from "./vscode"

type Language = ReturnType<typeof useLanguage>

export function shakeToast(message: SessionShakeCompletedMessage, language: Language) {
  return {
    variant: "success" as const,
    title: language.t(
      message.parts > 0
        ? message.tokens > 0
          ? "command.session.shake.cleared"
          : "command.session.shake.clearedParts"
        : "command.session.shake.empty",
      message.parts > 0 && message.tokens > 0
        ? { tokens: message.tokens.toLocaleString(language.locale()) }
        : undefined,
    ),
    description: message.diagnostics
      ? language.t("command.session.shake.diagnostics", {
          sessionID: message.sessionID,
          raw: message.diagnostics.rawMessages,
          projection: message.diagnostics.projectionMessages,
          tools: message.diagnostics.tools,
          completed: message.diagnostics.completed,
          protected: message.diagnostics.protected,
          compacted: message.diagnostics.compacted,
          candidates: message.diagnostics.candidates,
          tokens: message.tokens.toLocaleString(language.locale()),
        })
      : undefined,
  }
}

interface ShakeDeps {
  isConnected: () => boolean
  currentSessionID: () => string | undefined
  post: ReturnType<typeof useVSCode>["postMessage"]
  language: Language
}

export function createSessionShake(deps: ShakeDeps) {
  const [shaking, setShaking] = createSignal<string>()

  function shake() {
    if (!deps.isConnected()) {
      console.warn("[Kilo New] Cannot shake: not connected")
      return
    }

    const sessionID = deps.currentSessionID()
    if (!sessionID) {
      console.warn("[Kilo New] Cannot shake: no current session")
      return
    }

    if (shaking() === sessionID) return
    setShaking(sessionID)

    deps.post({ type: "shake", sessionID })
  }

  function handleMessage(message: ExtensionMessage): boolean {
    if (message.type === "sessionShakeCompleted") {
      if (shaking() === message.sessionID) setShaking(undefined)
      if (message.sessionID !== deps.currentSessionID()) return true
      showToast(shakeToast(message, deps.language))
      return true
    }
    if (message.type === "sessionShakeFailed") {
      if (shaking() === message.sessionID) setShaking(undefined)
      if (message.sessionID !== deps.currentSessionID()) return true
      showToast({
        variant: "error",
        title: deps.language.t("command.session.shake.failed"),
        description: message.error,
      })
      return true
    }
    return false
  }

  return { shaking, shake, handleMessage }
}
