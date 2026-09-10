// fork_change - new file
import type { SessionShakeCompletedMessage } from "../types/messages"
import type { useLanguage } from "./language"

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
