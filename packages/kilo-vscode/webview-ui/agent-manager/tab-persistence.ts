import type { Accessor, Setter } from "solid-js"
import { togglePinnedTab } from "./tab-order"
import { isTerminalTabId } from "./terminal/state"
import type { ProjectStore } from "./project/store"
import { withSessionColor } from "../src/utils/session-color-map" // fork_change

type TabPersistenceMessage =
  | { type: "agentManager.setTabOrder"; key: string; order: string[] }
  | { type: "agentManager.setPinnedTabs"; key: string; ids: string[] }
  | { type: "agentManager.setSessionColor"; sessionId: string; color: string | null } // fork_change

/**
 * Tab-order and pin persistence for the selected Agent Manager context.
 *
 * The store and host transport are injected so this module stays free of the
 * vscode API and the project registry. Callers spread `drag` into `createTabDrag`
 * and `tab` into the tab-rendering deps.
 */
export function createTabPersistence(
  store: Accessor<ProjectStore>,
  key: Accessor<string | null>,
  reviewId: string,
  post: (message: TabPersistenceMessage) => void,
) {
  const persistOrder = (target: string, order: string[]) => {
    const durable = order.filter((id) => id !== reviewId && !isTerminalTabId(id))
    post({ type: "agentManager.setTabOrder", key: target, order: durable })
  }
  const pinned = () => store().pinnedTabs()
  const setPinned: Setter<Record<string, string[]>> = (value) => store().setPinnedTabs(value)
  const persistPinned = (target: string, ids: string[]) => {
    post({ type: "agentManager.setPinnedTabs", key: target, ids })
  }
  const isPinned = (id: string) => {
    const target = key()
    return target !== null && (pinned()[target] ?? []).includes(id)
  }
  const togglePinned = (id: string) => {
    const target = key()
    if (target === null) return
    const next = togglePinnedTab(pinned()[target], id)
    setPinned((prev) => ({ ...prev, [target]: next }))
    persistPinned(target, next)
  }
  // fork_change start
  const colors = () => store().sessionColors()
  const setColor = (id: string, color: string | null) => {
    store().setSessionColors((prev) => withSessionColor(prev, id, color))
    post({ type: "agentManager.setSessionColor", sessionId: id, color })
  }
  const sessionColor = (id: string) => colors()[id]
  // fork_change end
  return {
    persistOrder,
    drag: { pinned, setPinned, persistPinned },
    // fork_change start
    tab: { isPinned, togglePinned, sessionColor, setSessionColor: setColor },
    // fork_change end
  }
}
