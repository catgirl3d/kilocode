// fork_change - new file
import { For, Show, createEffect, createSignal, on, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { useLanguage } from "../../context/language"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import type { BtwItem } from "../../types/messages"
import { quoteBtw } from "./prompt-input-utils"

interface BtwCardProps {
  sessionID: string
  onInsert: (text: string) => void
  onFollow: () => void
}

const failed = (status: BtwItem["status"]) => status !== "done" && status !== "running"

export const BtwCard: Component<BtwCardProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const server = useServer()
  const [copied, setCopied] = createSignal(false)
  // Events missed while disconnected or while the session was not tracked are not replayed; re-reading the list
  // on reconnect or a session switch corrects a stale running row.
  createEffect(
    on([() => props.sessionID, () => server.connectionState() === "connected"], ([id, connected]) => {
      if (connected) session.btw.refresh(id)
    }),
  )

  const state = () => session.btw.state(props.sessionID)
  const items = () => session.btw.current(props.sessionID)
  // Busy outlives its run until the next ask, so the note only shows while a start or a run is still in flight.
  const busy = () => state().busy && (state().request !== undefined || session.btw.running(props.sessionID))
  const latest = () =>
    items()
      .filter((item) => item.status === "done")
      .at(-1)

  const copy = (item: BtwItem) => {
    void navigator.clipboard
      .writeText(item.answer)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => console.error("[Kilo New] btw copy failed:", error))
  }

  const thread = () => (
    <>
      <Show when={busy()}>
        <div class="prompt-btw-busy">{language.t("prompt.btw.busy")}</div>
      </Show>
      <Show when={state().request}>
        <div class="prompt-btw-pending">
          <Spinner />
        </div>
      </Show>
      <For each={items()}>
        {(item) => (
          <div class="prompt-btw-item">
            <div class="prompt-btw-question">{item.question}</div>
            <Show when={item.answer}>
              <div class="prompt-btw-answer">
                <Markdown text={item.answer} />
              </div>
            </Show>
            <Show when={item.status === "running"}>
              <div class="prompt-btw-running">
                <Spinner />
                <Button
                  variant="ghost"
                  size="small"
                  icon="stop"
                  onClick={() => session.btw.cancel(props.sessionID, item.id)}
                >
                  {language.t("prompt.btw.cancel")}
                </Button>
              </div>
            </Show>
            <Show when={failed(item.status)}>
              <div class="prompt-btw-status">{language.t(`prompt.btw.status.${item.status}`)}</div>
            </Show>
            <Show when={item.error}>{(message) => <div class="prompt-btw-error">{message()}</div>}</Show>
          </div>
        )}
      </For>
      <Show when={latest()}>
        {(item) => (
          <div class="prompt-btw-actions">
            <Button
              variant="ghost"
              size="small"
              icon="speech-bubble"
              onClick={() => {
                session.btw.follow(props.sessionID)
                props.onFollow()
              }}
            >
              {language.t("prompt.btw.follow")}
            </Button>
            <Button
              variant="ghost"
              size="small"
              icon="arrow-down-to-line"
              onClick={() => props.onInsert(quoteBtw(item()))}
            >
              {language.t("prompt.btw.insert")}
            </Button>
            <Button variant="ghost" size="small" icon={copied() ? "check-small" : "copy"} onClick={() => copy(item())}>
              {language.t("prompt.btw.copy")}
            </Button>
          </div>
        )}
      </Show>
    </>
  )

  // A failed load shows its error below the list, so the empty state stays blank for it.
  const history = () => (
    <Show
      when={state().items.length > 0}
      fallback={
        <Show when={!state().error}>
          <Show
            when={state().loaded}
            fallback={
              <div class="prompt-btw-pending">
                <Spinner />
              </div>
            }
          >
            <div class="prompt-btw-empty">{language.t("prompt.btw.empty")}</div>
          </Show>
        </Show>
      }
    >
      <For each={state().items}>
        {(item) => (
          <button
            type="button"
            class="prompt-btw-history-item"
            onClick={() => session.btw.open(props.sessionID, item.threadID)}
          >
            <span class="prompt-btw-question">{item.question}</span>
            <Show when={failed(item.status)}>
              <span class="prompt-btw-status">{language.t(`prompt.btw.status.${item.status}`)}</span>
            </Show>
          </button>
        )}
      </For>
    </Show>
  )

  return (
    <Show when={state().open}>
      <div class="prompt-btw" data-slot="prompt-btw">
        <div class="prompt-btw-header">
          <span class="prompt-btw-title">{language.t("prompt.btw.title")}</span>
          <Show when={!state().history}>
            <IconButton
              icon="history"
              variant="ghost"
              size="small"
              aria-label={language.t("prompt.btw.history")}
              title={language.t("prompt.btw.history")}
              onClick={() => session.btw.history(props.sessionID)}
            />
          </Show>
          <IconButton
            icon="close-small"
            variant="ghost"
            size="small"
            aria-label={language.t("prompt.btw.close")}
            title={language.t("prompt.btw.close")}
            onClick={() => session.btw.close(props.sessionID)}
          />
        </div>
        <div class="prompt-btw-body">
          <Show when={state().history} fallback={thread()}>
            {history()}
          </Show>
          <Show when={state().error}>{(message) => <div class="prompt-btw-error">{message()}</div>}</Show>
        </div>
      </div>
    </Show>
  )
}
