// fork_change - new file
import type { EventSessionBtwUpdated } from "@kilocode/sdk/v2"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "@tui/config"
import { useBindings } from "@tui/keymap"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { getScrollAcceleration } from "@tui/util/scroll"
import { mergeBtw, parseBtwCommand, quoteBtw } from "@opencode-ai/core/kilocode/btw/client"
import { arm } from "@/kilocode/cli/cmd/tui/btw-command"
import { route } from "@/kilocode/cli/cmd/tui/memory-command"
import { errorMessage } from "@/util/error"
import { Locale } from "@/util/locale"

type Item = EventSessionBtwUpdated["properties"]["item"]
type Theme = ReturnType<typeof useTheme>["theme"]

function label(item: Item) {
  if (item.status === "running") return "running…"
  if (item.status === "error") return item.error ? `failed: ${item.error}` : "failed"
  return item.status
}

function tone(item: Item, theme: Theme) {
  if (item.status === "running") return theme.warning
  if (item.status === "error") return theme.error
  return theme.textMuted
}

function byCreated(a: Item, b: Item) {
  return a.time.created - b.time.created
}

function Turn(props: { item: Item }) {
  const { theme, syntax } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
        {props.item.question}
      </text>
      <Show when={props.item.answer}>
        <markdown
          syntaxStyle={syntax()}
          streaming={props.item.status === "running"}
          internalBlockMode="top-level"
          content={props.item.answer}
          conceal={false}
          fg={theme.markdownText}
          bg={theme.backgroundPanel}
        />
      </Show>
      <Show when={props.item.status !== "done"}>
        <text fg={tone(props.item, theme)} wrapMode="word">
          {label(props.item)}
        </text>
      </Show>
    </box>
  )
}

/** Side question dialog. With `item` it opens that item's thread; without it, the thread history list. */
export function DialogBtw(props: {
  sessionID: string
  workspace?: string
  directory?: string
  item?: Item
  draft?: () => string
}) {
  const sdk = useSDK()
  const event = useEvent()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const config = useTuiConfig()
  const scope = route({ workspace: props.workspace, directory: props.directory })
  const height = createMemo(() => Math.max(6, Math.min(24, Math.floor(dimensions().height * 0.7) - 8)))
  const scroll = createMemo(() => getScrollAcceleration(config))
  const [items, setItems] = createSignal(props.item ? [props.item] : [])
  const [thread, setThread] = createSignal(props.item?.threadID)
  const [history, setHistory] = createSignal(props.item === undefined)
  const [loaded, setLoaded] = createSignal(false)
  let box: ScrollBoxRenderable | undefined

  const sorted = createMemo(() => items().toSorted(byCreated))
  const turns = createMemo(() => sorted().filter((item) => item.threadID === thread()))
  const busy = () => items().some((item) => item.status === "running")
  const answered = () =>
    turns()
      .filter((item) => item.status === "done")
      .at(-1)

  function absorb(incoming: Item[]) {
    setItems((list) =>
      incoming.reduce((acc, item) => {
        const current = acc.find((entry) => entry.id === item.id)
        const next = mergeBtw(current, item)
        if (!current) return [...acc, next]
        return acc.map((entry) => (entry.id === item.id ? next : entry))
      }, list),
    )
  }

  // Closing this dialog cancels the running answer it was opened with, so follow-up and insert
  // are refused while any answer runs instead of silently cancelling it.
  function idle() {
    if (!busy()) return true
    toast.show({ variant: "warning", message: "Wait for the running side question to finish" })
    return false
  }

  async function append(text: string) {
    const result = await sdk.client.tui.appendPrompt({ ...scope, text })
    if (!result.error) return
    toast.show({ variant: "error", message: `Side question failed: ${errorMessage(result.error)}` })
  }

  function follow() {
    const id = thread()
    if (history() || !id || !idle()) return
    // The server continues only threads that have a finished answer.
    if (!answered()) {
      toast.show({ variant: "warning", message: "This thread has no finished answer to follow up on" })
      return
    }
    // "/btw " is inserted at the cursor, so a draft would turn the follow-up into a normal message to the agent.
    const text = props.draft?.() ?? ""
    if (text.trim() && !parseBtwCommand(text)) {
      toast.show({ variant: "warning", message: "Clear the prompt first, then follow up" })
      return
    }
    arm(props.sessionID, id)
    dialog.clear()
    if (!text.trim()) void append("/btw ")
  }

  function insert() {
    if (history() || !idle()) return
    const last = answered()
    if (!last) {
      toast.show({ variant: "warning", message: "No finished answer to insert yet" })
      return
    }
    const text = props.draft?.() ?? ""
    // The quote goes in at the cursor, so typed text needs a blank line before it to stay a block quote.
    const gap = text.trim() && !text.endsWith("\n") ? "\n\n" : ""
    dialog.clear()
    void append(gap + quoteBtw(last))
  }

  function toggle() {
    if (!history()) {
      setHistory(true)
      return
    }
    if (thread()) setHistory(false)
  }

  useBindings(() => ({
    bindings: [
      { key: "f", desc: "Follow up", group: "Side question", cmd: follow },
      { key: "i", desc: "Insert answer", group: "Side question", cmd: insert },
      { key: "h", desc: "Toggle history", group: "Side question", cmd: toggle },
      { key: "pageup", desc: "Scroll up", group: "Side question", cmd: () => box?.scrollBy(-height()) },
      { key: "pagedown", desc: "Scroll down", group: "Side question", cmd: () => box?.scrollBy(height()) },
    ],
  }))

  const off = event.on("session.btw.updated", (evt) => {
    if (evt.properties.sessionID !== props.sessionID) return
    absorb([evt.properties.item])
  })
  onCleanup(off)

  onMount(() => {
    dialog.setSize("large")
    sdk.client.session
      .btwList({ ...scope, sessionID: props.sessionID })
      .then((result) => {
        if (!result.data) throw new Error(errorMessage(result.error))
        absorb(result.data.items)
      })
      .catch((error: unknown) => {
        toast.show({ variant: "error", message: `Side questions failed to load: ${errorMessage(error)}` })
      })
      .finally(() => setLoaded(true))
  })

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    sorted()
      .filter((item) => item.id === item.threadID)
      .toReversed()
      .map((head) => {
        const last = sorted()
          .filter((item) => item.threadID === head.threadID)
          .at(-1)
        return {
          title: Locale.truncate(head.question, 80),
          value: head.threadID,
          footer: Locale.truncate(label(last ?? head), 32),
        }
      }),
  )

  return (
    <Show
      when={!history()}
      fallback={
        <DialogSelect
          title="Side questions"
          options={options()}
          renderFilter={false}
          footer={<text fg={theme.textMuted}>enter open · esc close</text>}
          onSelect={(option) => {
            setThread(option.value)
            setHistory(false)
          }}
        />
      }
    >
      <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Side question
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <scrollbox
          ref={(ref: ScrollBoxRenderable) => (box = ref)}
          height={height()}
          scrollAcceleration={scroll()}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{ visible: true }}
        >
          <Show
            when={turns().length > 0}
            fallback={<text fg={theme.textMuted}>{loaded() ? "No side questions in this thread." : "Loading..."}</text>}
          >
            <Index each={turns()}>{(item) => <Turn item={item()} />}</Index>
          </Show>
        </scrollbox>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>f follow up · i insert · h history · esc close</text>
          <text fg={theme.textMuted}>pageup/pagedown scroll</text>
        </box>
      </box>
    </Show>
  )
}
