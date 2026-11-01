// fork_change - new file
import { createStore, produce } from "solid-js/store"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { useLanguage } from "./language"
import type { useVSCode } from "./vscode"
import { previewStale } from "./session-reasoning"
import type {
  ExtensionMessage,
  ReasoningClearErrorCode,
  SessionToolClearPreviewRequest,
  SessionToolClearRequest,
  SessionToolClearedMessage,
} from "../types/messages"

type Language = ReturnType<typeof useLanguage>
type Post = (message: SessionToolClearPreviewRequest | SessionToolClearRequest) => void

export interface ToolPreview {
  keepTurns: number
  turns: number
  parts: number
  tokens: number
  token: string
}

export interface ToolState {
  keepTurns: number
  requestID?: string
  preview?: ToolPreview
  applied?: SessionToolClearedMessage
  previewing: boolean
  applying: boolean
  error?: { code: ReasoningClearErrorCode; message: string }
}

interface Deps {
  isConnected: () => boolean
  currentSessionID: () => string | undefined
  post: Post | ReturnType<typeof useVSCode>["postMessage"]
  language: Language
}

const DEFAULT: ToolState = {
  keepTurns: 10,
  previewing: false,
  applying: false,
}

const ERROR_KEYS: Record<ReasoningClearErrorCode, string> = {
  stale: "command.session.toolClear.stale",
  busy: "command.session.toolClear.error.busy",
  notFound: "command.session.toolClear.error.notFound",
  notConnected: "command.session.toolClear.error.notConnected",
  conflict: "command.session.toolClear.error.conflict",
  invalid: "command.session.toolClear.error.invalid",
  unknown: "command.session.toolClear.error.unknown",
}

function errorText(code: ReasoningClearErrorCode, message: string, language: Language): string {
  if ((code === "unknown" || code === "conflict") && message.trim()) return message.trim()
  return language.t(ERROR_KEYS[code])
}

export function toolClearToast(message: SessionToolClearedMessage, language: Language) {
  return {
    variant: "success" as const,
    title: language.t("command.session.toolClear.success", {
      parts: String(message.parts),
      turns: String(message.turns),
      tokens: message.tokens.toLocaleString(language.locale()),
    }),
  }
}

function id(): string {
  return crypto.randomUUID()
}

export function createSessionTools(deps: Deps) {
  const [store, setStore] = createStore<Record<string, ToolState>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function state(sessionID: string): ToolState {
    return store[sessionID] ?? DEFAULT
  }

  function cancel(sessionID: string) {
    const timer = timers.get(sessionID)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(sessionID)
  }

  function drop(sessionID: string) {
    cancel(sessionID)
    setStore(
      produce((map) => {
        delete map[sessionID]
      }),
    )
  }

  function fail(sessionID: string, code: ReasoningClearErrorCode, message = "") {
    setStore(sessionID, {
      ...state(sessionID),
      previewing: false,
      applying: false,
      applied: undefined,
      error: { code, message: errorText(code, message, deps.language) },
    })
  }

  function request(sessionID: string, keepTurns: number, notice?: { code: ReasoningClearErrorCode; message: string }) {
    cancel(sessionID)
    const current = state(sessionID)
    if (current.applying) return
    if (!deps.isConnected()) {
      fail(sessionID, "notConnected")
      return
    }
    const requestID = id()
    setStore(sessionID, {
      ...current,
      keepTurns,
      requestID,
      preview: undefined,
      previewing: true,
      applying: false,
      applied: undefined,
      error: notice,
    })
    deps.post({ type: "sessionToolClearPreview", sessionID, requestID, keepTurns })
  }

  function preview(sessionID: string, keepTurns: number, opts?: { delay?: number }) {
    cancel(sessionID)
    const delay = opts?.delay ?? 0
    if (delay > 0) {
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          const current = state(sessionID)
          if (current.keepTurns === keepTurns && (current.previewing || current.preview !== undefined)) return
          request(sessionID, keepTurns)
        }, delay),
      )
      return
    }
    request(sessionID, keepTurns)
  }

  function apply(sessionID: string, keepTurns: number, token: string) {
    cancel(sessionID)
    if (previewStale(state(sessionID).preview, keepTurns)) {
      fail(sessionID, "stale")
      return
    }
    if (!deps.isConnected()) {
      fail(sessionID, "notConnected")
      return
    }
    const requestID = id()
    setStore(sessionID, {
      ...state(sessionID),
      keepTurns,
      requestID,
      applying: true,
      previewing: false,
      applied: undefined,
      error: undefined,
    })
    deps.post({ type: "sessionToolClear", sessionID, requestID, keepTurns, token })
  }

  function handleMessage(message: ExtensionMessage): boolean {
    if (message.type === "sessionDeleted") {
      drop(message.sessionID)
      return false
    }
    if (
      message.type !== "sessionToolClearPreviewed" &&
      message.type !== "sessionToolCleared" &&
      message.type !== "sessionToolClearFailed"
    )
      return false

    const current = state(message.sessionID)
    if (current.requestID !== message.requestID) return true

    if (message.type === "sessionToolClearPreviewed") {
      setStore(message.sessionID, {
        ...current,
        previewing: false,
        applying: false,
        error: current.error?.code === "stale" ? current.error : undefined,
        preview: {
          keepTurns: current.keepTurns,
          turns: message.turns,
          parts: message.parts,
          tokens: message.tokens,
          token: message.token,
        },
      })
      return true
    }

    if (message.type === "sessionToolCleared") {
      setStore(message.sessionID, {
        ...current,
        requestID: undefined,
        previewing: false,
        applying: false,
        applied: message,
        preview: undefined,
        error: undefined,
      })
      if (message.sessionID === deps.currentSessionID()) {
        showToast(toolClearToast(message, deps.language))
      }
      return true
    }

    fail(message.sessionID, message.code, message.error)
    const notice = state(message.sessionID).error
    if (message.operation === "apply" && message.code === "stale") {
      if (notice) request(message.sessionID, current.keepTurns, notice)
      return true
    }
    // The dialog may already be closed, so an apply failure also surfaces as a toast.
    if (message.operation === "apply" && notice && message.sessionID === deps.currentSessionID()) {
      showToast({ variant: "error", title: notice.message })
    }
    return true
  }

  function clearing(sessionID: string): boolean {
    return state(sessionID).previewing || state(sessionID).applying
  }

  return { state, preview, apply, cancel, clearing, handleMessage, drop }
}
