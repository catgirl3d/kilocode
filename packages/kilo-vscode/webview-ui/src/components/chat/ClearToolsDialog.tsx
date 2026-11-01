// fork_change - new file
import { Component, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { previewStale, shouldCloseReasoningDialog } from "../../context/session-reasoning"
import type { ToolPreview } from "../../context/session-tools"
import { recallKeepTurns, rememberKeepTurns } from "../../utils/keep-turns"

interface Props {
  sessionID: string
}

function turns(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined
}

// Shares the reasoning dialog's `reasoning-clear-*` data-slots, so both previews are styled by dialogs.css.
export const ClearToolsDialog: Component<Props> = (props) => {
  const language = useLanguage()
  const session = useSession()
  const dialog = useDialog()
  const vscode = useVSCode()
  const start = recallKeepTurns(vscode, "tools")
  const [value, setValue] = createSignal(String(start))
  const [submitted, setSubmitted] = createSignal(false)

  const current = () => session.toolState(props.sessionID)
  const count = () => turns(value())
  const invalid = () => count() === undefined
  const preview = () => current().preview
  const busy = () => current().previewing || current().applying
  const pending = () => previewStale(preview(), count())
  // Display-only: keeps the last numbers on screen while a refreshed preview loads, so the card neither blinks nor resizes.
  // Apply guards still read the real preview().
  const shown = createMemo<ToolPreview | undefined>((last) => preview() ?? (current().previewing ? last : undefined))
  const stale = () => current().previewing || pending()
  const empty = () => {
    const item = shown()
    return !!item && item.parts === 0 && item.turns === 0
  }

  onMount(() => session.toolPreview(props.sessionID, start))
  // Covers a dialog replaced by another dialog.show(), which disposes it without calling onClose.
  onCleanup(() => session.toolCancel(props.sessionID))
  createEffect(
    on(
      value,
      (raw) => {
        if (current().applying) return
        const next = turns(raw)
        if (next !== undefined) session.toolPreview(props.sessionID, next, { delay: 300 })
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    const item = current()
    if (shouldCloseReasoningDialog(submitted(), item)) {
      setSubmitted(false)
      // Only a confirmed Clear is remembered, so peeking at other values does not stick.
      rememberKeepTurns(vscode, "tools", item.keepTurns)
      dialog.close()
    }
  })

  const apply = () => {
    const next = count()
    const item = preview()
    if (next === undefined || !item || pending() || empty() || busy()) return
    setSubmitted(true)
    session.toolClear(props.sessionID, next, item.token)
  }

  return (
    <Dialog
      title={language.t("command.session.toolClear.title")}
      fit
      action={
        <IconButton
          data-slot="dialog-close-button"
          icon="close"
          variant="ghost"
          aria-label={language.t("common.close")}
          disabled={current().applying}
          onClick={() => dialog.close()}
        />
      }
    >
      <div class="dialog-confirm-body">
        <p>{language.t("command.session.toolClear.description")}</p>
        {/* The wrapper reserves the validation message row so typing never resizes the dialog. */}
        <div data-slot="reasoning-clear-field">
          <TextField
            autofocus
            type="number"
            inputMode="numeric"
            min="1"
            max="100"
            step="1"
            label={language.t("command.session.toolClear.keepTurns")}
            disabled={current().applying}
            value={value()}
            onChange={setValue}
            validationState={invalid() ? "invalid" : undefined}
            error={invalid() ? language.t("command.session.toolClear.invalid") : undefined}
          />
        </div>
        <Show when={current().error}>
          {(error) => (
            <div data-slot="reasoning-clear-error" role="alert">
              {error().message}
            </div>
          )}
        </Show>
        <Show when={shown() || current().previewing}>
          <div data-slot="reasoning-clear-preview" data-stale={stale() ? "" : undefined}>
            <div>
              <span>{language.t("command.session.toolClear.turns")}</span>
              <strong>{shown()?.turns ?? "—"}</strong>
            </div>
            <div>
              <span>{language.t("command.session.toolClear.blocks")}</span>
              <strong>{shown()?.parts ?? "—"}</strong>
            </div>
            <div>
              <span>{language.t("command.session.toolClear.tokens")}</span>
              <strong>{shown()?.tokens.toLocaleString(language.locale()) ?? "—"}</strong>
            </div>
          </div>
        </Show>
        {/* One reserved row: status text swaps in place instead of pushing the buttons down. */}
        <div data-slot="reasoning-clear-statuses">
          <Show when={busy() && !shown()}>
            <div data-slot="reasoning-clear-status" role="status">
              {language.t("command.session.toolClear.loading")}
            </div>
          </Show>
          <Show when={empty()}>
            <div data-slot="reasoning-clear-status" role="status">
              {language.t("command.session.toolClear.empty")}
            </div>
          </Show>
        </div>
        <div class="dialog-confirm-actions">
          <Button variant="ghost" size="large" disabled={current().applying} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={busy() || invalid() || empty() || pending() || !preview()}
            onClick={apply}
          >
            <Show when={current().applying}>
              <Spinner />
            </Show>
            {language.t("command.session.toolClear.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
