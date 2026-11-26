// fork_change - new file
import { showToast } from "@kilocode/kilo-ui/toast"
import type { useLanguage } from "./language"
import type { useVSCode } from "./vscode"
import { createClearStore, id } from "./session-clear-store"
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
  includeHistory: boolean
  turns: number
  parts: number
  tokens: number
  token: string
}

export interface ToolState {
  keepTurns: number
  includeHistory: boolean
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
  includeHistory: false,
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

export function toolPreviewStale(
  preview: { keepTurns: number; includeHistory?: boolean } | undefined,
  keepTurns: number | undefined,
  includeHistory = false,
): boolean {
  if (preview === undefined) return false
  return preview.keepTurns !== keepTurns || (preview.includeHistory ?? false) !== includeHistory
}

export function toolClearToast(message: SessionToolClearedMessage, language: Language) {
  return {
    variant: "success" as const,
    title: language.t(
      message.includeHistory === true
        ? "command.session.toolClear.history.success"
        : "command.session.toolClear.success",
      {
        parts: String(message.parts),
        turns: String(message.turns),
        tokens: message.tokens.toLocaleString(language.locale()),
      },
    ),
  }
}

export function createSessionTools(deps: Deps) {
  const base = createClearStore({ fallback: DEFAULT, keys: ERROR_KEYS, language: deps.language })
  const state = base.state
  const cancel = base.cancel
  const drop = base.drop
  const fail = base.fail
  const setStore = base.setStore
  const schedule = base.schedule

  function request(
    sessionID: string,
    keepTurns: number,
    includeHistory: boolean,
    notice?: { code: ReasoningClearErrorCode; message: string },
  ) {
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
      includeHistory,
      requestID,
      preview: undefined,
      previewing: true,
      applying: false,
      applied: undefined,
      error: notice,
    })
    deps.post({
      type: "sessionToolClearPreview",
      sessionID,
      requestID,
      keepTurns,
      ...(includeHistory ? { includeHistory: true } : {}),
    })
  }

  function preview(sessionID: string, keepTurns: number, opts?: { delay?: number; includeHistory?: boolean }) {
    cancel(sessionID)
    const includeHistory = opts?.includeHistory ?? false
    const delay = opts?.delay ?? 0
    schedule(sessionID, delay, () => {
      if (delay > 0) {
        const current = state(sessionID)
        if (
          current.keepTurns === keepTurns &&
          current.includeHistory === includeHistory &&
          (current.previewing || current.preview !== undefined)
        )
          return
      }
      request(sessionID, keepTurns, includeHistory)
    })
  }

  function apply(sessionID: string, keepTurns: number, token: string, includeHistory = false) {
    cancel(sessionID)
    if (toolPreviewStale(state(sessionID).preview, keepTurns, includeHistory)) {
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
      includeHistory,
      requestID,
      applying: true,
      previewing: false,
      applied: undefined,
      error: undefined,
    })
    deps.post({
      type: "sessionToolClear",
      sessionID,
      requestID,
      keepTurns,
      token,
      ...(includeHistory ? { includeHistory: true } : {}),
    })
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
          includeHistory: message.includeHistory === true,
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
      if (notice) request(message.sessionID, current.keepTurns, current.includeHistory, notice)
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
