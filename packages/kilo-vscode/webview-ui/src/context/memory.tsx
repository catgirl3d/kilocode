// fork_change start
import { createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext } from "solid-js"
// fork_change end
import type { Accessor, ParentComponent } from "solid-js"
import { useServer } from "./server"
import { useSession } from "./session"
import { useVSCode } from "./vscode"
import { useLanguage } from "./language"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { MemoryStatusResponse } from "@kilocode/sdk/v2"
// fork_change start
import type { ExtensionMessage, Message, Part } from "../types/messages"
import { addMemoryActivity, markerActivity, type MemoryActivity } from "../utils/memory-activity"
import { visibleMessages, visibleParts } from "./session-queue"
// fork_change end

export interface MemoryContextValue {
  status: Accessor<MemoryStatusResponse | undefined>
  loading: Accessor<boolean>
  pending: Accessor<boolean>
  error: Accessor<string | undefined>
  enabled: Accessor<boolean>
  totalTokens: Accessor<number>
  // fork_change start
  activity: Accessor<MemoryActivity[]>
  // fork_change end
  refresh: () => void
  // fork_change start
  showMemory: () => void
  // fork_change end
  inspect: () => void
  enable: () => void
  disable: () => void
  auto: (mode: "on" | "off") => void
  // fork_change start
  verbose: (mode: "on" | "off") => void
  rebuild: () => void
  remember: () => void
  forget: () => void
  // fork_change end
}

export const MemoryContext = createContext<MemoryContextValue>()
const EVENT_DEDUPE_MS = 1000

// fork_change start
type Marker = { part: string; item: MemoryActivity }

// fork_change end
export const MemoryProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const server = useServer()
  const session = useSession()
  const language = useLanguage()
  const [status, setStatus] = createSignal<MemoryStatusResponse | undefined>()
  const [loading, setLoading] = createSignal(false)
  const [pending, setPending] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  // fork_change start
  const [saved, setSaved] = createSignal<MemoryActivity[]>([])
  const [markers, setMarkers] = createSignal<Record<string, Marker>>({})
  // fork_change end

  const id = () => session.currentSessionID()
  const key = (sid?: string) => sid ?? ""
  const current = (sid?: string) => {
    if (!sid) return true
    // A response can be addressed to a draft session that hasn't been promoted to
    // currentSessionID yet (PromptInput posts with the draft id), so match both.
    return sid === id() || sid === session.draftSessionID()
  }
  // fork_change start
  const marker = (parts: readonly Part[], at: number) => {
    for (const part of parts) {
      const item = markerActivity([part], at)
      if (item) return { part: part.id, item } satisfies Marker
    }
  }
  const stamp = (message: Message) => message.time?.created ?? Date.parse(message.createdAt)
  const mark = (messageID: string, part: Part, at: number) => {
    const item = marker([part], at)
    setMarkers((items) => {
      if (item) return { ...items, [messageID]: item }
      if (items[messageID]?.part !== part.id) return items
      const next = { ...items }
      delete next[messageID]
      return next
    })
  }
  const load = (message: Extract<ExtensionMessage, { type: "messagesLoaded" }>) => {
    if (!current(message.sessionID)) return
    const next = message.mode === "replace" || !message.mode ? {} : { ...markers() }
    for (const entry of message.messages) {
      const item = marker(entry.parts ?? [], stamp(entry))
      if (item) next[entry.id] = item
      else delete next[entry.id]
    }
    setMarkers(next)
  }
  const created = (message: Extract<ExtensionMessage, { type: "messageCreated" }>) => {
    if (!current(message.message.sessionID)) return
    const item = marker(message.message.parts ?? [], stamp(message.message))
    if (item) setMarkers((items) => ({ ...items, [message.message.id]: item }))
  }
  const dropped = (messageID: string) =>
    setMarkers((items) => {
      if (!items[messageID]) return items
      const next = { ...items }
      delete next[messageID]
      return next
    })
  const track = (message: ExtensionMessage) => {
    if (message.type === "messagesLoaded") return load(message)
    if (message.type === "messageCreated") return created(message)
    if (message.type === "partUpdated") {
      if (current(message.sessionID)) mark(message.messageID, message.part, Date.now())
      return
    }
    if (message.type === "partsUpdated") {
      for (const update of message.updates) {
        if (current(update.sessionID)) mark(update.messageID, update.part, Date.now())
      }
      return
    }
    if (message.type === "partRemoved") {
      if (!current(message.sessionID)) return
      if (markers()[message.messageID]?.part === message.partID) dropped(message.messageID)
      return
    }
    if (message.type === "messageRemoved" && current(message.sessionID)) dropped(message.messageID)
  }
  const scan = () => {
    const next: Record<string, Marker> = {}
    for (const message of session.messages()) {
      const item = marker(session.getParts(message.id), stamp(message))
      if (item) next[message.id] = item
    }
    setMarkers(next)
  }
  // fork_change end
  let last: { key: string; time: number } | undefined
  let scope = ""

  const clear = () => {
    setStatus(undefined)
    setError(undefined)
    setPending(undefined)
    // fork_change start
    setSaved([])
    setMarkers({})
    // fork_change end
    last = undefined
  }

  const refresh = () => {
    if (!server.isConnected()) return
    setLoading(true)
    setError(undefined)
    vscode.postMessage({ type: "requestMemory", sessionID: id() })
  }

  // fork_change start
  const operation = (op: "enable" | "disable" | "rebuild" | "verbose", mode?: "on" | "off") => {
    if (!server.isConnected()) return
    setPending(key(id()))
    setError(undefined)
    vscode.postMessage({
      type: "memoryOperation",
      operation: op,
      ...(mode ? { mode } : {}),
      sessionID: id(),
    })
  }
  // fork_change end

  const auto = (mode: "on" | "off") => {
    if (!server.isConnected()) return
    setPending(key(id()))
    setError(undefined)
    vscode.postMessage({ type: "memoryOperation", operation: "auto", mode, sessionID: id() })
  }

  const inspect = () => {
    if (!server.isConnected()) return
    setPending(key(id()))
    setError(undefined)
    vscode.postMessage({ type: "memoryOperation", operation: "inspect", sessionID: id() })
  }

  // fork_change start
  const prompt = (op: "remember" | "forget") => {
    if (!server.isConnected()) return
    setPending(key(id()))
    setError(undefined)
    vscode.postMessage({ type: "memoryPrompt", operation: op, sessionID: id() })
  }

  const showMemory = () => {
    if (!server.isConnected()) return
    setLoading(true)
    setError(undefined)
    vscode.postMessage({ type: "memoryShow", sessionID: id() })
  }

  // fork_change end
  const event = (message: Extract<ExtensionMessage, { type: "memoryEvent" }>) => {
    if (!current(message.sessionID)) return
    // fork_change start
    if (message.detail.type === "saved") {
      setSaved((items) => addMemoryActivity(items, message.detail, Date.now()))
      return
    }
    // fork_change end
    if (message.detail.type !== "error") return
    if (!message.detail.message) return
    const dedupeKey = `${message.sessionID ?? ""}:${message.detail.type ?? ""}:${message.detail.message}`
    const now = Date.now()
    if (last?.key === dedupeKey && now - last.time < EVENT_DEDUPE_MS) return
    last = { key: dedupeKey, time: now }
    showToast({ variant: "error", title: message.detail.message })
  }

  const loaded = (message: Extract<ExtensionMessage, { type: "memoryLoaded" }>) => {
    if (!current(message.sessionID)) return
    setLoading(false)
    if (message.error) {
      setError(message.error)
      setStatus(undefined)
      return
    }
    if (message.status) setStatus(message.status)
    setError(undefined)
  }

  const done = (message: Extract<ExtensionMessage, { type: "memoryOperationResult" }>) => {
    if (pending() === key(message.sessionID)) setPending(undefined)
    if (!current(message.sessionID)) return
    setLoading(false)
    if (!message.ok) {
      const err = message.error ?? language.t("chat.memory.command.failed")
      setError(err)
      showToast({ variant: "error", title: err })
      return
    }
    if (message.status) setStatus(message.status)
    setError(undefined)
    if (message.operation === "remember" || message.operation === "correct" || message.operation === "forget") {
      showToast({ variant: "success", title: language.t("chat.memory.updated") })
    }
    if (message.operation === "rebuild") {
      showToast({ variant: "success", title: language.t("chat.memory.rebuild") })
    }
  }

  const receive = (message: ExtensionMessage) => {
    // fork_change start
    track(message)
    // fork_change end
    if (message.type === "memoryEvent") {
      event(message)
      return
    }
    if (message.type === "memoryLoaded") {
      loaded(message)
      return
    }
    if (message.type === "memoryOperationResult") {
      done(message)
      return
    }
    if (message.type === "extensionDataReady" && server.isConnected() && !status()) refresh()
  }

  const unsubscribe = vscode.onMessage(receive)

  onCleanup(unsubscribe)

  createEffect(() => {
    const sid = id()
    const dir = server.workspaceDirectory()
    const connected = server.isConnected()
    const next = `${connected ? "1" : "0"}:${sid ?? ""}:${dir ?? ""}`
    if (scope !== next) {
      scope = next
      clear()
      // fork_change start
      untrack(scan)
      // fork_change end
    }
    if (!connected) {
      setLoading(false)
      return
    }
    refresh()
  })

  const total = createMemo(() => status()?.index.estimatedTokens ?? 0)

  // fork_change start
  const activity = createMemo(() => {
    const revert = session.currentSession()?.revert ?? undefined
    const visible = new Set(
      visibleMessages(session.messages(), revert, (message) => session.getParts(message.id)).map(
        (message) => message.id,
      ),
    )
    const items = Object.entries(markers()).flatMap(([mid, entry]) => {
      if (!revert) return [entry.item]
      if (!visible.has(mid)) return []
      if (mid !== revert.messageID || !revert.partID) return [entry.item]
      const parts = visibleParts(mid, session.getParts(mid), revert)
      return parts.some((part) => part.id === entry.part) ? [entry.item] : []
    })
    return [...items, ...saved()]
  })

  // fork_change end
  const value: MemoryContextValue = {
    status,
    loading,
    pending: createMemo(() => pending() === key(id())),
    error,
    enabled: createMemo(() => status()?.state.enabled ?? false),
    totalTokens: total,
    // fork_change start
    activity,
    // fork_change end
    refresh,
    // fork_change start
    showMemory,
    // fork_change end
    inspect,
    enable: () => operation("enable"),
    disable: () => operation("disable"),
    auto,
    // fork_change start
    verbose: (mode) => operation("verbose", mode),
    rebuild: () => operation("rebuild"),
    remember: () => prompt("remember"),
    forget: () => prompt("forget"),
    // fork_change end
  }

  return <MemoryContext.Provider value={value}>{props.children}</MemoryContext.Provider>
}

export function useMemory(): MemoryContextValue {
  const context = useContext(MemoryContext)
  if (!context) {
    throw new Error("useMemory must be used within a MemoryProvider")
  }
  return context
}
