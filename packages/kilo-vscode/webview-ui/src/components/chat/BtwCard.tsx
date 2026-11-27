// fork_change - new file
import { For, Show, createEffect, createSignal, on, onCleanup, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { isEnterKeyCommitNotIme } from "../../utils/ime-enter"
import { createSpeechShortcut } from "../speech-to-text/shortcut"
import { SpeechToTextButton } from "../speech-to-text/SpeechToTextButton"
import type { SpeechToText } from "../speech-to-text/useSpeechToText"
import { insertSpacedText } from "./prompt-input-utils"
import type { BtwItem } from "../../types/messages"
import { quoteBtw } from "@opencode-ai/core/kilocode/btw/client"

interface BtwCardProps {
  sessionID: string
  onInsert: (text: string) => void
  onFollow: () => void
  onAsk?: (question: string) => boolean
  onClose?: () => void
  speech?: SpeechToText
  startSpeech?: (insert: (text: string) => void) => void
  speechEnabled?: () => boolean
  speechOwner?: () => "prompt" | "btw"
}

const failed = (status: BtwItem["status"]) => status !== "done" && status !== "running"

export const BtwCard: Component<BtwCardProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  const [question, setQuestion] = createSignal("")
  let inputRef: HTMLInputElement | undefined
  let reset: ReturnType<typeof setTimeout> | undefined

  const state = () => session.btw.state(props.sessionID)
  const items = () => session.btw.current(props.sessionID)
  const latest = () =>
    items()
      .filter((item) => item.status === "done")
      .at(-1)

  const busy = () => !!state().request || session.btw.running(props.sessionID)

  const ask = () => {
    const value = question().trim()
    if (!value || busy() || props.speech?.active()) return
    if (props.onAsk) {
      if (!props.onAsk(value)) return
      setQuestion("")
      return
    }
    session.btw.ask(props.sessionID, value)
    setQuestion("")
  }

  const close = () => {
    if (props.speechOwner?.() === "btw" && props.speech?.active()) props.speech.cancel()
    session.btw.close(props.sessionID)
    props.onClose?.()
  }

  const insertQuestionText = (value: string) => {
    const ref = inputRef
    if (!ref) return
    const start = ref.selectionStart ?? question().length
    const end = ref.selectionEnd ?? start
    const result = insertSpacedText(question(), value, start, end)
    setQuestion(result.text)
    ref.value = result.text
    ref.setSelectionRange(result.pos, result.pos)
    ref.focus()
  }

  const startCardSpeech = () => props.startSpeech?.(insertQuestionText)

  const shortcut =
    props.speech && props.startSpeech
      ? createSpeechShortcut({
          speech: props.speech,
          disabled: () => !props.speechEnabled?.() || busy(),
          start: startCardSpeech,
          finish: () => props.speech?.stop(),
        })
      : undefined

  const speechDown = (event: KeyboardEvent) => {
    if (!shortcut) return false
    if (props.speech?.active() && props.speechOwner?.() !== "btw") return false
    if (!shortcut.down(event)) return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const speechVisible = () =>
    !!props.speech &&
    !!props.startSpeech &&
    (props.speech.active() ? props.speechOwner?.() === "btw" : !!props.speechEnabled?.())

  createEffect(
    on(
      () => `${props.sessionID}|${state().open}|${state().history}`,
      () => {
        if (props.speechOwner?.() === "btw" && props.speech?.active()) props.speech.cancel()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (state().open && state().compose) inputRef?.focus()
  })

  createEffect(
    on(
      () => props.sessionID,
      () => setQuestion(""),
      { defer: true },
    ),
  )

  const copy = (item: BtwItem) => {
    void navigator.clipboard
      .writeText(item.answer)
      .then(() => {
        setCopied(true)
        if (reset) clearTimeout(reset)
        reset = setTimeout(() => setCopied(false), 2000)
      })
      .catch((error: unknown) => console.error("[Kilo New] btw copy failed:", error))
  }

  onCleanup(() => {
    if (reset) clearTimeout(reset)
    shortcut?.reset()
    if (props.speechOwner?.() === "btw" && props.speech?.active()) props.speech.cancel()
  })

  const thread = () => (
    <>
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
                <Button variant="ghost" size="small" icon="stop" onClick={() => session.btw.cancel(props.sessionID)}>
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
                props.onFollow()
                session.btw.follow(props.sessionID)
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
            onClick={close}
          />
        </div>
        <div class="prompt-btw-body">
          <Show when={state().history} fallback={thread()}>
            {history()}
          </Show>
          <Show when={state().error}>{(message) => <div class="prompt-btw-error">{message()}</div>}</Show>
        </div>
        <Show when={!state().history}>
          <div class="prompt-btw-ask">
            <input
              ref={inputRef}
              value={question()}
              placeholder={language.t("prompt.btw.placeholder")}
              aria-label={language.t("prompt.btw.ask")}
              onInput={(event) => setQuestion(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.isComposing || event.keyCode === 229) return
                if (speechDown(event)) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  close()
                  return
                }
                if (!isEnterKeyCommitNotIme(event) || event.shiftKey) return
                event.preventDefault()
                ask()
              }}
            />
            <Show when={speechVisible() ? props.speech : undefined}>
              {(speech) => (
                <SpeechToTextButton
                  speech={speech()}
                  disabled={busy()}
                  start={startCardSpeech}
                  label={language.t}
                  ownsSpeech={false}
                  context={language.t("prompt.btw.dictate")}
                />
              )}
            </Show>
            <IconButton
              icon="send"
              variant="ghost"
              size="small"
              aria-label={language.t("prompt.btw.send")}
              disabled={busy() || !!props.speech?.active() || !question().trim()}
              onClick={ask}
            />
          </div>
        </Show>
      </div>
    </Show>
  )
}
