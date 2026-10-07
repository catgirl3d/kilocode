// fork_change - new file
import { For, Show, createSignal, onCleanup, type Component, type JSX } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tag } from "@kilocode/kilo-ui/tag"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { SECTION_COLORS, colorCss } from "../../../agent-manager/section-colors"
import { useLanguage } from "../../context/language"
import { useSessionTags } from "../../context/session-tags"
import { useVSCode } from "../../context/vscode"
import type { SessionTag, SessionTagAction, SessionTagError } from "../../types/messages"

type SessionTagsProps = { sessionID: string; compact?: boolean }
type SessionTagsStore = ReturnType<typeof useSessionTags>
type SessionTagsLanguage = ReturnType<typeof useLanguage>
type SessionTagsVSCode = ReturnType<typeof useVSCode>

export const SessionTags: Component<SessionTagsProps> = (props) => {
  const tags = useSessionTags()
  const language = useLanguage()
  const list = () => tags.forSession(props.sessionID)

  return (
    <Show when={list().length > 0}>
      <Tooltip
        placement="top"
        value={
          <div data-slot="session-tags-tooltip">
            <strong>{language.t("session.tags.title")}</strong>
            <For each={list()}>
              {(tag) => (
                <span
                  data-slot="session-tags-tooltip-item"
                  style={{ "--session-tag-color": colorCss(tag.color) ?? "var(--text-weak)" } as JSX.CSSProperties}
                >
                  {tag.name}
                </span>
              )}
            </For>
          </div>
        }
      >
        <span
          data-slot="session-tags"
          data-compact={props.compact ? "" : undefined}
          aria-label={list()
            .map((tag) => tag.name)
            .join(", ")}
        >
          <For each={list().slice(0, 2)}>
            {(tag) => (
              <Tag
                class="session-tag-chip"
                data-slot="session-tag"
                style={{ "--session-tag-color": colorCss(tag.color) ?? "var(--text-weak)" } as JSX.CSSProperties}
              >
                <span data-slot="session-tag-name">{tag.name}</span>
              </Tag>
            )}
          </For>
          <Show when={list().length > 2}>
            <span data-slot="session-tags-overflow">+{list().length - 2}</span>
          </Show>
          <Show when={props.compact}>
            <span data-slot="session-tags-compact-count">{list().length}</span>
          </Show>
        </span>
      </Tooltip>
    </Show>
  )
}

export const SessionTagsButton: Component<{ sessionID: string }> = (props) => {
  const tags = useSessionTags()
  const language = useLanguage()
  const open = useSessionTagsDialog()
  const label = () => language.t("session.tags.manage")

  return (
    <IconButton
      type="button"
      class="session-tags-button"
      data-slot="session-tags-button"
      icon="bullet-list"
      size="small"
      variant="ghost"
      disabled={!tags.ready()}
      aria-label={label()}
      title={label()}
      onClick={(event) => open(props.sessionID, event.currentTarget)}
    />
  )
}

export function useSessionTagsDialog() {
  const dialog = useDialog()
  const tags = useSessionTags()
  const language = useLanguage()
  const vscode = useVSCode()

  return (sessionID: string, origin?: HTMLElement) => {
    if (!tags.ready()) return
    const life = { closed: false, unsubscribe: () => {} }
    dialog.show(
      () => (
        <SessionTagsEditor
          sessionID={sessionID}
          tags={tags}
          language={language}
          vscode={vscode}
          life={life}
          close={dialog.close}
        />
      ),
      () => {
        life.closed = true
        life.unsubscribe()
        queueMicrotask(() => {
          if (origin?.isConnected) origin.focus()
        })
      },
    )
  }
}

function SessionTagsEditor(props: {
  sessionID: string
  tags: SessionTagsStore
  language: SessionTagsLanguage
  vscode: SessionTagsVSCode
  life: { closed: boolean; unsubscribe: () => void }
  close: () => void
}) {
  const [mode, setMode] = createSignal<"closed" | "create" | SessionTag>("closed")
  const [name, setName] = createSignal("")
  const [color, setColor] = createSignal("Blue")
  const [confirm, setConfirm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [gone, setGone] = createSignal(false)
  const [error, setError] = createSignal<SessionTagError>()
  const [query, setQuery] = createSignal("") // fork_change

  const editing = () => {
    const value = mode()
    return typeof value === "string" ? undefined : value
  }

  const unsubscribe = props.vscode.onMessage((message) => {
    if (props.life.closed || message.type !== "sessionDeleted" || message.sessionID !== props.sessionID) return
    setGone(true)
    props.close()
  })
  props.life.unsubscribe = unsubscribe
  if (props.life.closed) unsubscribe()
  onCleanup(() => {
    props.life.closed = true
    unsubscribe()
  })

  async function run(action: SessionTagAction) {
    if (!props.tags.ready() || busy() || gone()) return false
    setBusy(true)
    setError(undefined)
    const result = await (async () => {
      try {
        return await props.tags.mutate(action)
      } catch (err) {
        console.error("[Kilo New] Session tag action failed", err)
        return { ok: false, error: "storage" as const }
      }
    })()
    if (props.life.closed || gone()) return false
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? "storage")
      return false
    }
    return true
  }

  function reset() {
    setMode("closed")
    setName("")
    setColor("Blue")
    setConfirm(false)
    setError(undefined)
  }

  function create() {
    setMode("create")
    setName("")
    setColor("Blue")
    setConfirm(false)
    setError(undefined)
  }

  function edit(tag: SessionTag) {
    setMode({ ...tag })
    setName(tag.name)
    setColor(tag.color)
    setConfirm(false)
    setError(undefined)
  }

  async function save() {
    if (mode() === "closed") return
    const base = editing()
    if (!base) {
      if (await run({ type: "create", sessionID: props.sessionID, name: name().trim(), color: color() })) reset()
      return
    }

    const patch: Partial<Pick<SessionTag, "name" | "color">> = {}
    const next = name().trim()
    if (next !== base.name) patch.name = next
    if (color() !== base.color) patch.color = color()
    if (patch.name === undefined && patch.color === undefined) {
      reset()
      return
    }
    if (await run({ type: "update", id: base.id, patch })) reset()
  }

  async function remove() {
    const tag = editing()
    if (!tag) return
    if (!confirm()) {
      setConfirm(true)
      setError(undefined)
      return
    }
    if (await run({ type: "delete", id: tag.id })) reset()
  }

  const errorText = () => {
    const code = error()
    return code ? props.language.t(`session.tags.error.${code}`) : undefined
  }

  // fork_change start - local tag search
  const matches = () => {
    const value = query().trim().toLowerCase()
    return props.tags.state().tags.filter((tag) => tag.name.toLowerCase().includes(value))
  }
  // fork_change end

  return (
    <Dialog title={props.language.t("session.tags.title")} size="normal" fit class="session-tags-dialog">
      <div class="session-tags-editor">
        <Show
          when={props.tags.ready()}
          fallback={<div data-slot="session-tags-loading">{props.language.t("common.loading")}</div>}
        >
          {/* fork_change start - filter tag catalog */}
          <Show
            when={props.tags.state().tags.length > 0}
            fallback={<div data-slot="session-tags-empty">{props.language.t("session.tags.empty")}</div>}
          >
            <TextField
              label={props.language.t("session.tags.search")}
              hideLabel
              placeholder={props.language.t("session.tags.search.placeholder")}
              value={query()}
              onChange={setQuery}
            />
            <Show
              when={matches().length > 0}
              fallback={<div data-slot="session-tags-no-results">{props.language.t("session.tags.search.empty")}</div>}
            >
              <div data-slot="session-tags-editor-list">
                <For each={matches()}>
                  {(tag) => (
                    <div data-slot="session-tags-editor-row">
                      <Checkbox
                        checked={props.tags.forSession(props.sessionID).some((item) => item.id === tag.id)}
                        disabled={busy() || gone() || confirm()}
                        onChange={(assigned) =>
                          void run({ type: "assign", sessionID: props.sessionID, id: tag.id, assigned })
                        }
                      >
                        <span data-slot="session-tags-editor-label">
                          <span
                            data-slot="session-tags-color-dot"
                            style={
                              { "--session-tag-color": colorCss(tag.color) ?? "var(--text-weak)" } as JSX.CSSProperties
                            }
                          />
                          <span data-slot="session-tags-editor-name">{tag.name}</span>
                        </span>
                      </Checkbox>
                      <IconButton
                        type="button"
                        icon="edit"
                        size="small"
                        variant="ghost"
                        disabled={busy() || gone() || confirm()}
                        aria-label={`${props.language.t("common.edit")}: ${tag.name}`}
                        onClick={() => edit(tag)}
                      />
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          {/* fork_change end */}

          <Show when={mode() === "closed"}>
            <Button
              type="button"
              data-slot="session-tags-new"
              variant="ghost"
              size="small"
              icon="plus"
              disabled={busy() || gone()}
              onClick={() => create()}
            >
              {props.language.t("session.tags.new")}
            </Button>
          </Show>

          <Show when={mode() !== "closed"}>
            <div
              data-slot="session-tags-editor-form"
              ref={(el) =>
                queueMicrotask(() => el.querySelector<HTMLInputElement>('[data-slot="input-input"]')?.focus())
              }
            >
              <div data-slot="session-tags-editor-heading">
                {props.language.t(editing() ? "session.tags.edit" : "session.tags.new")}
              </div>
              <Show when={editing()}>
                <p data-slot="session-tags-global-note">{props.language.t("session.tags.globalNote")}</p>
              </Show>
              <TextField
                label={props.language.t("session.tags.name")}
                placeholder={props.language.t("session.tags.name.placeholder")}
                value={name()}
                disabled={busy() || gone() || confirm()}
                onChange={setName}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  void save()
                }}
              />
              <div data-slot="session-tags-color-label">{props.language.t("session.tags.color")}</div>
              <div
                data-slot="session-tags-color-picker"
                role="group"
                aria-label={props.language.t("session.tags.color")}
              >
                <For each={SECTION_COLORS}>
                  {(item) => (
                    <Button
                      type="button"
                      class="session-tags-color"
                      variant="ghost"
                      size="small"
                      disabled={busy() || gone() || confirm()}
                      aria-label={props.language.t(`session.tags.color.${item.label}`)}
                      aria-pressed={color() === item.label}
                      title={props.language.t(`session.tags.color.${item.label}`)}
                      onClick={() => setColor(item.label)}
                    >
                      <span data-slot="session-tags-color-swatch" style={{ background: colorCss(item.label) }} />
                    </Button>
                  )}
                </For>
              </div>
              <Show when={errorText()}>
                <div data-slot="session-tags-error" role="alert">
                  {errorText()}
                </div>
              </Show>
              <Show when={editing() && confirm()}>
                <div data-slot="session-tags-delete-confirm">
                  <p>{props.language.t("session.tags.delete.confirm", { name: editing()?.name ?? "" })}</p>
                  <div data-slot="session-tags-editor-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      disabled={busy() || gone()}
                      onClick={() => setConfirm(false)}
                    >
                      {props.language.t("common.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="small"
                      disabled={busy() || gone()}
                      onClick={() => void remove()}
                    >
                      {props.language.t("session.tags.delete.confirmAction")}
                    </Button>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <div data-slot="session-tags-editor-actions">
            <Show when={mode() !== "closed" && !confirm()}>
              <Show when={editing()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={busy() || gone()}
                  onClick={() => void remove()}
                >
                  {props.language.t("session.tags.deleteEverywhere")}
                </Button>
              </Show>
              <span data-slot="session-tags-editor-spacer" />
              <Button type="button" variant="ghost" size="small" disabled={busy() || gone()} onClick={() => reset()}>
                {props.language.t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="small"
                disabled={busy() || gone()}
                onClick={() => void save()}
              >
                {props.language.t(editing() ? "common.save" : "common.add")}
              </Button>
            </Show>
            <Show when={mode() === "closed" || confirm()}>
              <span data-slot="session-tags-editor-spacer" />
              <Button
                type="button"
                variant="ghost"
                size="small"
                disabled={busy() || gone()}
                onClick={() => props.close()}
              >
                {props.language.t("common.close")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
