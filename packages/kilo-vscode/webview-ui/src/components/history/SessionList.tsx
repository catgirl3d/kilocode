/**
 * SessionList component
 * Displays all sessions grouped by date, with context menu for rename/delete.
 * Uses kilo-ui List component for keyboard navigation and accessibility.
 * Header/back button are owned by the parent HistoryView.
 */

import { Component, Show, createMemo, createSignal, onMount, type Accessor, type JSX } from "solid-js"
import { List } from "@kilocode/kilo-ui/list"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox" // fork_change
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useSessionTags } from "../../context/session-tags" // fork_change
import { useLocalTabs } from "../../context/local-tabs" // fork_change
import { ColorMenuItems } from "../../../agent-manager/color-menu" // fork_change
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
  // fork_change start
  const tabs = useLocalTabs()
  const tags = useSessionTags()
  const openTags = useSessionTagsDialog()
  const colorOf = (id: string) => props.sessionColor?.(id) ?? tabs?.sessionColor(id)
  const setColor = (id: string, color: string | null) => (props.setSessionColor ?? tabs?.setSessionColor)?.(id, color)
  // fork_change end

  const [renamingId, setRenamingId] = createSignal<string | null>(null)
  const [pendingRenameId, setPendingRenameId] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal("")
  let seq = 0

  // fork_change start - derive tag search values without mutating SessionInfo
  const tagged = createMemo(() =>
    session.sessions().map((item) => ({
      ...item,
      tags: tags
        .forSession(item.id)
        .map((tag) => tag.name)
        .join(" "),
    })),
  )
  const items = createMemo(() => {
    const ids = props.sessionIds?.()
    return ids ? tagged().filter((item) => ids.has(item.id)) : tagged()
  })
  // fork_change end

  onMount(() => {
    console.log("[Kilo New] SessionList mounted, loading sessions")
    session.loadSessions()
  })

  // fork_change start - current selection must use the derived List item
  const currentSession = (): (SessionInfo & { tags: string }) | undefined => {
    const id = session.currentSessionID()
    return items().find((s) => s.id === id)
  }
  // fork_change end

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
                <IconButton
                  data-slot="session-row-action"
                  icon="edit"
                  size="small"
                  variant="ghost"
                  aria-label={label(language.t("common.rename"), item)}
                  onClick={() => startRename(item)}
                />
                {/* fork_change start - keep the tag action outside the List button */}
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
                {/* fork_change end */}
                <IconButton
                  data-slot="session-row-action"
                  icon="trash"
                  size="small"
                  variant="ghost"
                  aria-label={label(language.t("session.delete.title"), item)}
                  onClick={(event) => confirmDelete(item, event.currentTarget)}
                />
                <Show when={props.rowActions}>{props.rowActions?.(item)}</Show>
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
            {/* fork_change start - assign a session color from the row menu */}
            <Show when={props.setSessionColor ?? tabs?.setSessionColor}>
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
      {/* fork_change start - include session tags in local search and rows */}
      <List<SessionInfo & { tags: string }>
        items={items()}
        key={(s) => s.id}
        filterKeys={["title", "tags"]}
        current={currentSession()}
        onMove={announce}
        onSelect={(s) => {
          if (!s) return
          if (selecting()) {
            toggle(s.id)
            return
          }
          if (renamingId() !== s.id) {
            props.onSelectSession(s.id)
          }
        }}
        search={{
          placeholder: language.t("session.search.placeholder"),
          autofocus: true,
          action: (
            <Show
              when={selecting()}
              fallback={
                <Button class="session-select-toggle" variant="ghost" size="small" onClick={() => setSelecting(true)}>
                  {language.t("session.select.enter")}
                </Button>
              }
            >
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
        }}
        emptyMessage={language.t("session.empty")}
        groupBy={(s) => language.t(dateGroupKey(s.updatedAt))}
        sortGroupsBy={(a, b) => {
          const rank = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [language.t(k), i]))
          return (rank[a.category] ?? 99) - (rank[b.category] ?? 99)
        }}
        itemWrapper={wrapItem}
      >
        {(s) => (
          <>
            <SessionColorStripe sessionID={s.id} color={colorOf(s.id)} />
            <span data-slot="list-item-title" dir="auto">
              {name(s)}
            </span>
            <SessionTags sessionID={s.id} />
            <span data-slot="list-item-description">{formatRelativeDate(s.updatedAt)}</span>
            <Show when={session.currentSessionID() === s.id}>
              <span class="sr-only">{language.t("session.current")}</span>
            </Show>
          </>
        )}
      </List>
      {/* fork_change end */}
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
