// fork_change - new file
import type { Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { Part as SDKPart, ToolPart } from "@kilocode/sdk/v2"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"

/** A finished question tool part that the chat can be reverted to. */
export function revertible(part: SDKPart) {
  if (part.type !== "tool") return false
  const tool = part as ToolPart
  return tool.tool === "question" && tool.state.status === "completed"
}

/**
 * Reverts the session to just after an answered question: the question and its
 * answer stay, files return to the snapshot taken when it was asked, and
 * everything after the answer is undone until the next message is sent.
 */
export const QuestionRevert: Component<{ messageID: string; partID: string }> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const busy = () => session.status() !== "idle"
  return (
    <div data-slot="question-revert" title={busy() ? language.t("revert.disabled.agentBusy") : undefined}>
      <Button
        variant="ghost"
        size="small"
        disabled={busy()}
        onClick={() => {
          if (busy()) return
          session.revertSession(props.messageID, props.partID)
        }}
      >
        {language.t("question.revert")}
      </Button>
    </div>
  )
}
