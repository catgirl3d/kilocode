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
// fork_change start - tag scope helpers
type TagScope = "project" | "global"

const tagScope = (tag: Pick<SessionTag, "scope">): TagScope => (tag.scope === "global" ? "global" : "project")
const globalTag = (tag: Pick<SessionTag, "scope">) => tagScope(tag) === "global"
// fork_change end

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
  const [scope, setScope] = createSignal<"project" | "global">("project") // fork_change
  const [confirm, setConfirm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [gone, setGone] = createSignal(false)
  const [error, setError] = createSignal<SessionTagError>()
  const [query, setQuery] = createSignal("") // fork_change
  let editor: HTMLDivElement | undefined // fork_change

  const editing = () => {
    const value = mode()
    return typeof value === "string" ? undefined : value
  }
  // fork_change start - selected scope presentation and translations
  const selectedScope = (value: TagScope) => scope() === value
  const scopeText = () => {
    const value = scope()
    const base = editing()
    const saved = base ? tagScope(base) : "project"
    return {
      note: props.language.t(`session.tags.note.${value}`),
      delete: props.language.t(`session.tags.delete.${saved}`),
      confirm: props.language.t(`session.tags.delete.confirm.${saved}`, { name: base?.name ?? "" }),
    }
  }
  // fork_change end

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
    setScope("project") // fork_change
    setConfirm(false)
    setError(undefined)
    if (editor) editor.scrollTop = 0 // fork_change
  }

  function create() {
    setMode("create")
    setName("")
    setColor("Blue")
    setScope("project") // fork_change
    setConfirm(false)
    setError(undefined)
  }

  function edit(tag: SessionTag) {
    setMode({ ...tag })
    setName(tag.name)
    setColor(tag.color)
    setScope(tagScope(tag)) // fork_change
    setConfirm(false)
    setError(undefined)
  }

  async function save() {
    if (mode() === "closed") return
    const base = editing()
    if (!base) {
      // fork_change start - include scope in create actions
      if (
        await run({ type: "create", sessionID: props.sessionID, name: name().trim(), color: color(), scope: scope() })
      ) {
        reset()
      }
      // fork_change end
      return
    }

    const patch: Partial<Pick<SessionTag, "name" | "color">> & { scope?: "global" | "project" } = {} // fork_change
    const next = name().trim()
    if (next !== base.name) patch.name = next
    if (color() !== base.color) patch.color = color()
    const previous = tagScope(base) // fork_change
    if (scope() !== previous) patch.scope = scope() // fork_change
    if (patch.name === undefined && patch.color === undefined && patch.scope === undefined) {
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

  // fork_change start - keep assigned tags on top without reordering while toggling
  const pinned = new Set(props.tags.forSession(props.sessionID).map((tag) => tag.id))
  const matches = () => {
    const value = query().trim().toLowerCase()
    const found = props.tags.state().tags.filter((tag) => tag.name.toLowerCase().includes(value))
    return [...found.filter((tag) => pinned.has(tag.id)), ...found.filter((tag) => !pinned.has(tag.id))]
  }
  // fork_change end

  return (
    <Dialog title={props.language.t("session.tags.title")} size="normal" fit class="session-tags-dialog">
      <div class="session-tags-editor" ref={(el) => (editor = el)} /* fork_change */>
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
                    <div data-slot="session-tags-editor-row" data-scope={tagScope(tag)}>
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
                          <Show when={globalTag(tag)}>
                            <span data-slot="session-tags-scope-badge">
                              {props.language.t("session.tags.scope.globalShort")}
                            </span>
                          </Show>
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
              {/* fork_change start - scope-aware editor controls */}
              <p data-slot="session-tags-scope-note">{scopeText().note}</p>
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
              <div data-slot="session-tags-scope">
                <div data-slot="session-tags-color-label">{props.language.t("session.tags.scope.label")}</div>
                <div role="group" aria-label={props.language.t("session.tags.scope.label")}>
                  <Button
                    type="button"
                    class="session-tags-scope"
                    variant="ghost"
                    size="small"
                    disabled={busy() || gone() || confirm()}
                    aria-pressed={selectedScope("project")}
                    onClick={() => setScope("project")}
                  >
                    {props.language.t("session.tags.scope.project")}
                  </Button>
                  <Button
                    type="button"
                    class="session-tags-scope"
                    variant="ghost"
                    size="small"
                    disabled={busy() || gone() || confirm()}
                    aria-pressed={selectedScope("global")}
                    onClick={() => setScope("global")}
                  >
                    {props.language.t("session.tags.scope.global")}
                  </Button>
                </div>
              </div>
              {/* fork_change end */}
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
                  {/* fork_change start - scope-aware delete confirmation */}
                  <p>{scopeText().confirm}</p>
                  {/* fork_change end */}
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
                  {/* fork_change start - scope-aware delete action */}
                  {scopeText().delete}
                  {/* fork_change end */}
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
