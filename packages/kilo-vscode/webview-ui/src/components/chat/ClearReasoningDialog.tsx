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
import { previewStale, shouldCloseReasoningDialog, type ReasoningPreview } from "../../context/session-reasoning"

interface Props {
  sessionID: string
}

function turns(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined
}

export const ClearReasoningDialog: Component<Props> = (props) => {
  const language = useLanguage()
  const session = useSession()
  const dialog = useDialog()
  const [value, setValue] = createSignal("10")
  const [submitted, setSubmitted] = createSignal(false)

  const current = () => session.reasoningState(props.sessionID)
  const count = () => turns(value())
  const invalid = () => count() === undefined
  const preview = () => current().preview
  const busy = () => current().previewing || current().applying
  const pending = () => previewStale(preview(), count())
  // Display-only: keeps the last numbers on screen while a refreshed preview loads, so the card neither blinks nor resizes.
  // Apply guards still read the real preview().
  const shown = createMemo<ReasoningPreview | undefined>(
    (last) => preview() ?? (current().previewing ? last : undefined),
  )
  const stale = () => current().previewing || pending()
  const empty = () => {
    const item = shown()
    return !!item && item.parts === 0 && item.turns === 0
  }
  const preserved = () => {
    const item = shown()
    return item && item.unsupported > 0 ? item : undefined
  }

  onMount(() => session.reasoningPreview(props.sessionID, 10))
  // Covers a dialog replaced by another dialog.show(), which disposes it without calling onClose.
  onCleanup(() => session.reasoningCancel(props.sessionID))
  createEffect(
    on(
      value,
      (raw) => {
        if (current().applying) return
        const next = turns(raw)
        if (next !== undefined) session.reasoningPreview(props.sessionID, next, { delay: 300 })
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    const item = current()
    if (shouldCloseReasoningDialog(submitted(), item)) {
      setSubmitted(false)
      dialog.close()
    }
  })

  const apply = () => {
    const next = count()
    const item = preview()
    if (next === undefined || !item || pending() || empty() || busy()) return
    setSubmitted(true)
    session.reasoningClear(props.sessionID, next, item.token)
  }

  return (
    <Dialog
      title={language.t("command.session.reasoningClear.title")}
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
        <p>{language.t("command.session.reasoningClear.description")}</p>
        {/* The wrapper reserves the validation message row so typing never resizes the dialog. */}
        <div data-slot="reasoning-clear-field">
          <TextField
            autofocus
            type="number"
            inputMode="numeric"
            min="1"
            max="100"
            step="1"
            label={language.t("command.session.reasoningClear.keepTurns")}
            disabled={current().applying}
            value={value()}
            onChange={setValue}
            validationState={invalid() ? "invalid" : undefined}
            error={invalid() ? language.t("command.session.reasoningClear.invalid") : undefined}
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
              <span>{language.t("command.session.reasoningClear.turns")}</span>
              <strong>{shown()?.turns ?? "—"}</strong>
            </div>
            <div>
              <span>{language.t("command.session.reasoningClear.blocks")}</span>
              <strong>{shown()?.parts ?? "—"}</strong>
            </div>
            <div>
              <span>{language.t("command.session.reasoningClear.tokens")}</span>
              <strong>{shown()?.tokens.toLocaleString(language.locale()) ?? "—"}</strong>
            </div>
          </div>
        </Show>
        {/* One reserved row: status text swaps in place instead of pushing the buttons down. */}
        <div data-slot="reasoning-clear-statuses">
          <Show when={busy() && !shown()}>
            <div data-slot="reasoning-clear-status" role="status">
              {language.t("command.session.reasoningClear.loading")}
            </div>
          </Show>
          <Show when={preserved()}>
            {(item) => (
              <div data-slot="reasoning-clear-status" role="status">
                {language.t("command.session.reasoningClear.preserved", { count: String(item().unsupported) })}
              </div>
            )}
          </Show>
          <Show when={empty()}>
            <div data-slot="reasoning-clear-status" role="status">
              {language.t("command.session.reasoningClear.empty")}
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
            {language.t("command.session.reasoningClear.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
