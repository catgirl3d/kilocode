import type { AgentManagerInMessage } from "./types"
import type { WorktreeStateManager } from "./WorktreeStateManager"
import { setSessionColor } from "../session-colors" // fork_change

/**
 * Persist tab-bar layout for one sidebar context ("local" or a worktree id).
 *
 * Order and pins are stored side by side because the tab bar derives its final
 * sequence from both: pinned tabs lead, the saved drag order fills the rest.
 * Returns true when the message was a layout message and has been handled.
 */
export function handleTabLayoutMessage(state: WorktreeStateManager | undefined, msg: AgentManagerInMessage): boolean {
  if (msg.type === "agentManager.setTabOrder") {
    state?.setTabOrder(msg.key, msg.order)
    return true
  }
  if (msg.type === "agentManager.setPinnedTabs") {
    state?.setPinnedTabs(msg.key, msg.ids)
    return true
  }
  // fork_change start
  if (msg.type === "agentManager.setSessionColor") {
    void setSessionColor(msg.sessionId, msg.color)
    return true
  }
  // fork_change end
  return false
}
