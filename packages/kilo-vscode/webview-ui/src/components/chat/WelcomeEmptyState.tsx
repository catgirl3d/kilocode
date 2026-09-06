// fork_change start - hide feedback button from the welcome screen
import { type Component, For, Show, createMemo } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { recentSessions } from "../../context/session-utils"
import { DATE_GROUP_KEYS, dateGroupKey, formatRelativeDate } from "../../utils/date"
import type { SessionInfo } from "../../types/messages"
// fork_change end

interface WelcomeEmptyStateProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
}

export const KiloLogo = () => {
  const icons = (window as { ICONS_BASE_URI?: string }).ICONS_BASE_URI || ""
  const light =
    document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light")
  const file = light ? "kilo-light.svg" : "kilo-dark.svg"

  return (
    <div class="kilo-logo">
      <img src={`${icons}/${file}`} alt="Kilo Code" />
    </div>
  )
}

export const WelcomeEmptyState: Component<WelcomeEmptyStateProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const recent = () => recentSessions(session.sessions())

  // fork_change start - group recent sessions by date
  const groups = createMemo(() => {
    const ranked = new Map(DATE_GROUP_KEYS.map((key, index) => [key, index]))
    const byKey = new Map<(typeof DATE_GROUP_KEYS)[number], SessionInfo[]>()
    for (const item of recent()) {
      const key = dateGroupKey(item.updatedAt)
      byKey.set(key, [...(byKey.get(key) ?? []), item])
    }
    return [...byKey.entries()]
      .sort((a, b) => (ranked.get(a[0]) ?? 99) - (ranked.get(b[0]) ?? 99))
      .map(([key, items]) => ({ key, title: language.t(key), items }))
  })
  // fork_change end
  return (
    <div class="message-list-empty">
      <KiloLogo />
      <p class="kilo-about-text">{language.t("session.messages.welcome")}</p>
      <Show when={recent().length > 0 && props.onSelectSession}>
        <div class="recent-sessions">
          {/* fork_change start - grouped rows by date */}
          <For each={groups()}>
            {(group) => (
              <>
                <span class="recent-session-group">{group.title}</span>
                <For each={group.items}>
                  {(item) => (
                    <button class="recent-session-item" onClick={() => props.onSelectSession?.(item.id)}>
                      <span class="recent-session-title" dir="auto">
                        {item.title || language.t("session.untitled")}
                      </span>
                      <span class="recent-session-date">{formatRelativeDate(item.updatedAt)}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          {/* fork_change end */}
          <Show when={props.onShowHistory}>
            <button class="show-history-btn" onClick={() => props.onShowHistory?.()}>
              <Icon name="history" size="small" />
              {language.t("session.showHistory")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
