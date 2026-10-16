/**
 * SessionList component
 * Displays all sessions grouped by date, with context menu for rename/delete.
 * Uses kilo-ui List component for keyboard navigation and accessibility.
 * Header/back button are owned by the parent HistoryView.
 */

// fork_change start - reactive tag filter imports
import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js"
// fork_change end
import { List } from "@kilocode/kilo-ui/list"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox" // fork_change
import { showToast } from "@kilocode/kilo-ui/toast" // fork_change
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { rootSessions } from "../../context/session-utils" // fork_change
import { useLanguage } from "../../context/language"
import { useSessionTags } from "../../context/session-tags" // fork_change
import { useSessionFavorites } from "../../context/session-favorites" // fork_change
import { useLocalTabs } from "../../context/local-tabs" // fork_change
import { ColorMenuItems } from "../../../agent-manager/color-menu" // fork_change
import { colorCss } from "../../../agent-manager/section-colors" // fork_change
import { formatRelativeDate } from "../../utils/date"
import { DATE_GROUP_KEYS, dateGroupKey } from "../../utils/date" // fork_change
import type { SessionInfo } from "../../types/messages"
import { SessionRenameEditor } from "../shared/SessionRenameEditor"
import { SessionTags, useSessionTagsDialog } from "../shared/SessionTags" // fork_change
import { SessionColorStripe } from "../shared/SessionColorStripe" // fork_change

interface SessionListProps {
  onSelectSession: (id: string) => void
  sessionIds?: Accessor<ReadonlySet<string> | undefined>
  /** Extra per-row actions rendered after rename/delete (e.g. Agent Manager menus). */
  rowActions?: (session: SessionInfo) => JSX.Element
  // fork_change start - session colors owned by the host view; falls back to local tabs
  sessionColor?: (id: string) => string | undefined
  setSessionColor?: (id: string, color: string | null) => void
  // fork_change end
}

const SessionList: Component<SessionListProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const dialog = useDialog()
  // fork_change start - wire session tags and colors into the history view
  const tabs = useLocalTabs()
  const tags = useSessionTags()
  const favorites = useSessionFavorites()
  const openTags = useSessionTagsDialog()
  const colorOf = (id: string) => props.sessionColor?.(id) ?? tabs?.sessionColor(id)
  const setColor = (id: string, color: string | null) => (props.setSessionColor ?? tabs?.setSessionColor)?.(id, color)
  // fork_change end

  const [renamingId, setRenamingId] = createSignal<string | null>(null)
  const [pendingRenameId, setPendingRenameId] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal("")
  // fork_change start - selected history tag filters
  const [chosenTags, setChosenTags] = createSignal<Set<string>>(new Set())
  // fork_change end
  let seq = 0

  // fork_change start - derive tag search and favorite values without mutating SessionInfo
  const tagged = createMemo(() =>
    rootSessions(session.sessions()).map((item) => {
      const sessionTags = tags.forSession(item.id)
      return {
        ...item,
        tags: sessionTags.map((tag) => tag.name).join(" "),
        tagIds: sessionTags.map((tag) => tag.id),
        favorite: favorites.isFavorite(item.id),
      }
    }),
  )
  // fork_change end

  // fork_change start - scope tag filters and sessions to the current session list
  const base = createMemo(() => {
    const ids = props.sessionIds?.()
    return ids ? tagged().filter((item) => ids.has(item.id)) : tagged()
  })
  const filterTags = createMemo(() => {
    const scoped = props.sessionIds?.()
    const ids =
      scoped === undefined
        ? new Set(Object.values(tags.state().sessions).flat())
        : new Set(base().flatMap((item) => item.tagIds))
    return tags.state().tags.filter((tag) => ids.has(tag.id))
  })
  const items = createMemo(() => {
    const source = base()
    const chosen = chosenTags()
    if (chosen.size === 0) return source
    return source.filter((item) => item.tagIds.some((id) => chosen.has(id)))
  })
  const match = createMemo(() => {
    const chosen = chosenTags()
    return chosen.size > 0 && base().some((item) => item.tagIds.some((id) => chosen.has(id)))
  })
  // fork_change end

  // fork_change start - load older sessions for unscoped tag filters
  createEffect(() => {
    if (props.sessionIds?.() !== undefined) return
    if (!filterTags().some((tag) => chosenTags().has(tag.id))) return
    if (chosenTags().size === 0 || !session.sessionsHasMore() || session.sessionsLoadingMore()) return
    session.loadMoreSessions()
  })
  // fork_change end

  // fork_change start - keep tag filters valid when the visible tag catalog changes
  createEffect(() => {
    const ids = new Set(filterTags().map((tag) => tag.id))
    setChosenTags((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  })

  function toggleTag(id: string) {
    setChosenTags((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // fork_change end

  // fork_change start - single favorite toggle that surfaces write failures
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())

  function toggleFavorite(item: SessionInfo) {
    if (pending().has(item.id)) return
    const favorite = !favorites.isFavorite(item.id)
    setPending((current) => new Set(current).add(item.id))
    void favorites
      .mutate({ type: "set", sessionID: item.id, favorite })
      .then((result) => {
        if (result.ok) return
        showToast({ variant: "error", title: language.t("session.favorites.error") })
      })
      .finally(() => {
        setPending((current) => {
          const next = new Set(current)
          next.delete(item.id)
          return next
        })
      })
  }
  // fork_change end

  onMount(() => {
    console.log("[Kilo New] SessionList mounted, loading sessions")
    session.loadSessions()
  })

  // fork_change start - current selection must use the derived List item
  const currentSession = (): (SessionInfo & { tags: string; tagIds: string[]; favorite: boolean }) | undefined => {
    // fork_change end
    const id = session.currentSessionID()
    return items().find((s) => s.id === id)
  }

  function startRename(s: SessionInfo) {
    setRenamingId(s.id)
  }

  function saveRename(title: string) {
    const id = renamingId()
    if (!id) return
    const existing = session.sessions().find((s) => s.id === id)
    if (!existing || title !== (existing.title || "")) session.renameSession(id, title)
    setRenamingId(null)
  }

  function cancelRename() {
    setRenamingId(null)
  }

  // fork_change start - bulk selection mode for deleting several sessions at once
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const chosen = createMemo(() => items().filter((s) => selected().has(s.id)))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startSelect(id: string) {
    setSelected(new Set([id]))
    setSelecting(true)
  }

  function stopSelect() {
    setSelecting(false)
    setSelected(new Set<string>())
  }

  function confirmBulkDelete() {
    if (chosen().length === 0) return
    dialog.show(() => (
      <Dialog title={language.t("session.select.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("session.select.confirm", { count: chosen().length })}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                for (const item of chosen()) session.deleteSession(item.id)
                dialog.close()
                stopSelect()
              }}
            >
              {language.t("common.delete")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  // fork_change end

  function name(s: SessionInfo) {
    return s.title || language.t("session.untitled")
  }

  function label(action: string, s: SessionInfo) {
    return `${action}: ${name(s)}`
  }

  function announce(s: SessionInfo | undefined) {
    const id = ++seq
    setNotice("")
    if (!s) return
    queueMicrotask(() => {
      if (id !== seq) return
      const current = session.currentSessionID() === s.id ? `. ${language.t("session.current")}` : ""
      setNotice(`${name(s)}${current}`)
    })
  }

  function confirmDelete(s: SessionInfo, restore?: HTMLElement) {
    dialog.show(
      () => (
        <Dialog title={language.t("session.delete.title")} fit>
          <div class="dialog-confirm-body">
            <span>{language.t("session.delete.confirm", { name: name(s) })}</span>
            <div class="dialog-confirm-actions">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  session.deleteSession(s.id)
                  dialog.close()
                }}
              >
                {language.t("session.delete.button")}
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {
        queueMicrotask(() => {
          if (restore?.isConnected) restore.focus()
        })
      },
    )
  }

  function wrapItem(item: SessionInfo, node: JSX.Element): JSX.Element {
    let trigger: HTMLButtonElement | undefined // fork_change
    return (
      <ContextMenu>
        <ContextMenu.Trigger as="div" class="session-row">
          <Show
            when={renamingId() === item.id}
            fallback={
              <>
                {node}
                {/* fork_change start - bulk selection checkbox stays outside the List button */}
                <Show when={selecting()}>
                  <div class="session-select-check">
                    <Checkbox checked={selected().has(item.id)} onChange={() => toggle(item.id)} hideLabel>
                      {name(item)}
                    </Checkbox>
                  </div>
                </Show>
                {/* fork_change end */}
                {/* fork_change start - overlay the hover actions instead of reserving row space */}
                <div data-slot="session-row-actions">
                  <IconButton
                    data-slot="session-row-action"
                    icon="edit"
                    size="small"
                    variant="ghost"
                    aria-label={label(language.t("common.rename"), item)}
                    onClick={() => startRename(item)}
                  />
                  {/* keep the tag action outside the List button */}
                  <IconButton
                    ref={(el) => {
                      trigger = el
                    }}
                    data-slot="session-row-action"
                    class="session-tags-button"
                    icon="bullet-list"
                    size="small"
                    variant="ghost"
                    disabled={!tags.ready()}
                    aria-label={label(language.t("session.tags.manage"), item)}
                    title={language.t("session.tags.manage")}
                    onClick={(event) => openTags(item.id, event.currentTarget)}
                  />
                  {/* toggle local session favorites from history rows */}
                  <IconButton
                    data-slot="session-row-action"
                    class="session-favorite-button"
                    icon={favorites.isFavorite(item.id) ? "star-filled" : "star"}
                    size="small"
                    variant="ghost"
                    disabled={!favorites.ready() || pending().has(item.id)}
                    aria-pressed={favorites.isFavorite(item.id)}
                    aria-label={label(
                      language.t(favorites.isFavorite(item.id) ? "session.favorites.remove" : "session.favorites.add"),
                      item,
                    )}
                    title={language.t(
                      favorites.isFavorite(item.id) ? "session.favorites.remove" : "session.favorites.add",
                    )}
                    onClick={() => toggleFavorite(item)}
                  />
                  <IconButton
                    data-slot="session-row-action"
                    class="session-select-button"
                    icon="checklist"
                    size="small"
                    variant="ghost"
                    aria-label={label(language.t("session.select.enter"), item)}
                    title={language.t("session.select.enter")}
                    onClick={() => startSelect(item.id)}
                  />
                  <IconButton
                    data-slot="session-row-action"
                    icon="trash"
                    size="small"
                    variant="ghost"
                    aria-label={label(language.t("session.delete.title"), item)}
                    onClick={(event) => confirmDelete(item, event.currentTarget)}
                  />
                  <Show when={props.rowActions}>{props.rowActions?.(item)}</Show>
                </div>
                {/* fork_change end */}
              </>
            }
          >
            <div data-slot="session-row-editor">
              <SessionRenameEditor title={item.title || ""} fill onSave={saveRename} onCancel={cancelRename} />
            </div>
          </Show>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            class="session-list-menu"
            onCloseAutoFocus={(event) => {
              if (pendingRenameId() !== item.id) return
              event.preventDefault()
              setPendingRenameId(null)
              startRename(item)
            }}
          >
            <ContextMenu.Item onSelect={() => setPendingRenameId(item.id)}>
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => session.exportSessionTranscript(item.id)}>
              <ContextMenu.ItemLabel>{language.t("command.session.export")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            {/* fork_change start - open the shared tag editor from the menu */}
            <ContextMenu.Item disabled={!tags.ready()} onSelect={() => openTags(item.id, trigger)}>
              <ContextMenu.ItemLabel>{language.t("session.tags.manage")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            {/* fork_change end */}
            {/* fork_change start - toggle local session favorites from the row menu */}
            <ContextMenu.Item
              disabled={!favorites.ready() || pending().has(item.id)}
              onSelect={() => toggleFavorite(item)}
            >
              <ContextMenu.ItemLabel>
                {language.t(favorites.isFavorite(item.id) ? "session.favorites.remove" : "session.favorites.add")}
              </ContextMenu.ItemLabel>
            </ContextMenu.Item>
            {/* fork_change end */}
            {/* fork_change start - enter bulk selection from the row menu */}
            <Show when={!selecting()}>
              <ContextMenu.Item onSelect={() => startSelect(item.id)}>
                <ContextMenu.ItemLabel>{language.t("session.select.enter")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            {/* fork_change end */}
            {/* fork_change start - assign a session color from the row menu (local sessions only) */}
            <Show when={(props.setSessionColor ?? tabs?.setSessionColor) && !item.id.startsWith("cloud:")}>
              <ContextMenu.Separator />
              <ColorMenuItems
                label={language.t("agentManager.section.setColor")}
                color={colorOf(item.id)}
                onSet={(color) => setColor(item.id, color)}
              />
            </Show>
            {/* fork_change end */}
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => confirmDelete(item)}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )
  }

  return (
    <div class="session-list">
      <List<SessionInfo & { tags: string; tagIds: string[]; favorite: boolean }> /* fork_change */
        items={items()}
        key={(s) => s.id}
        filterKeys={["title", "tags"]} /* fork_change - include session tags in local search and rows */
        current={currentSession()}
        onMove={announce}
        onSelect={(s) => {
          // fork_change start - multi-select mode
          if (!s) return
          if (selecting()) {
            toggle(s.id)
            return
          }
          if (renamingId() !== s.id) {
            // fork_change end
            props.onSelectSession(s.id)
          }
        }}
        /* fork_change start - add bulk selection controls to the session search */
        search={{
          placeholder: language.t("session.search.placeholder"),
          autofocus: true,
          action: (
            <Show when={selecting()}>
              <div class="session-select-bar">
                <span class="session-select-count">
                  {language.t("session.select.count", { count: chosen().length })}
                </span>
                <Button variant="ghost" size="small" onClick={stopSelect}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" size="small" disabled={chosen().length === 0} onClick={confirmBulkDelete}>
                  {language.t("common.delete")}
                </Button>
              </div>
            </Show>
          ),
          below: (
            <Show when={tags.ready() && filterTags().length > 0}>
              <div data-slot="session-tag-filters" role="group" aria-label={language.t("session.tags.title")}>
                <For each={filterTags()}>
                  {(tag) => (
                    <Button
                      type="button"
                      class="session-tag-filter"
                      size="small"
                      variant="ghost"
                      aria-label={tag.name}
                      aria-pressed={chosenTags().has(tag.id)}
                      style={{ "--session-tag-color": colorCss(tag.color) ?? "var(--text-weak)" } as JSX.CSSProperties}
                      onClick={() => toggleTag(tag.id)}
                    >
                      <span data-slot="session-tag-filter-name">{tag.name}</span>
                    </Button>
                  )}
                </For>
              </div>
            </Show>
          ),
        }}
        /* fork_change end */
        /* fork_change start - dynamic empty message for tag filtering */
        emptyMessage={language.t(
          chosenTags().size > 0 && !match() && session.sessionsHasMore()
            ? "session.tags.filter.searching"
            : chosenTags().size > 0
              ? "session.tags.filter.empty"
              : "session.empty",
        )}
        /* fork_change end */
        /* fork_change start - group favorites before date groups */
        groupBy={(s) => (s.favorite ? language.t("session.favorites.group") : language.t(dateGroupKey(s.updatedAt)))}
        /* fork_change end */
        sortGroupsBy={(a, b) => {
          /* fork_change start - sort the favorites group before date groups */
          const favorite = language.t("session.favorites.group")
          if (a.category === favorite) return b.category === favorite ? 0 : -1
          if (b.category === favorite) return 1
          /* fork_change end */
          const rank = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [language.t(k), i]))
          return (rank[a.category] ?? 99) - (rank[b.category] ?? 99)
        }}
        itemWrapper={wrapItem}
      >
        {(s) => (
          <>
            {/* fork_change start - display session colors in each list row */}
            <SessionColorStripe sessionID={s.id} color={colorOf(s.id)} />
            {/* fork_change end */}
            <span data-slot="list-item-title" dir="auto">
              {name(s)}
            </span>
            {/* fork_change start - display session tags in each list row */}
            <SessionTags sessionID={s.id} />
            {/* fork_change end */}
            <span data-slot="list-item-description">{formatRelativeDate(s.updatedAt)}</span>
            <Show when={session.currentSessionID() === s.id}>
              <span class="sr-only">{language.t("session.current")}</span>
            </Show>
          </>
        )}
      </List>
      <Show when={props.sessionIds?.() === undefined && session.sessionsHasMore()}>
        <div class="session-list-load-more">
          <Button
            variant="ghost"
            size="small"
            disabled={session.sessionsLoadingMore()}
            onClick={() => session.loadMoreSessions()}
          >
            {language.t("common.loadMore") ?? "Load more"}
          </Button>
        </div>
      </Show>
      <div data-slot="session-list-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice()}
      </div>
    </div>
  )
}

export default SessionList
