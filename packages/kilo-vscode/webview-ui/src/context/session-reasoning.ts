// fork_change - new file
import { createStore, produce } from "solid-js/store"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { useLanguage } from "./language"
import type { useVSCode } from "./vscode"
import type {
  ExtensionMessage,
  ReasoningClearErrorCode,
  SessionReasoningClearPreviewRequest,
  SessionReasoningClearRequest,
  SessionReasoningClearedMessage,
} from "../types/messages"

type Language = ReturnType<typeof useLanguage>
type Post = (message: SessionReasoningClearPreviewRequest | SessionReasoningClearRequest) => void

export interface ReasoningPreview {
  keepTurns: number
  includeCarriers: boolean
  turns: number
  parts: number
  tokens: number
  carriers: number
  carrierCandidates: number
  unsupported: number
  token: string
}

export interface ReasoningState {
  keepTurns: number
  includeCarriers: boolean
  requestID?: string
  preview?: ReasoningPreview
  applied?: SessionReasoningClearedMessage
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

const DEFAULT: ReasoningState = {
  keepTurns: 10,
  includeCarriers: false,
  previewing: false,
  applying: false,
}

const ERROR_KEYS: Record<ReasoningClearErrorCode, string> = {
  stale: "command.session.reasoningClear.stale",
  busy: "command.session.reasoningClear.error.busy",
  notFound: "command.session.reasoningClear.error.notFound",
  notConnected: "command.session.reasoningClear.error.notConnected",
  conflict: "command.session.reasoningClear.error.conflict",
  invalid: "command.session.reasoningClear.error.invalid",
  unknown: "command.session.reasoningClear.error.unknown",
}

export function previewStale(
  preview: { keepTurns: number; includeCarriers?: boolean } | undefined,
  keepTurns: number | undefined,
  includeCarriers = false,
): boolean {
  if (preview === undefined) return false
  return preview.keepTurns !== keepTurns || (preview.includeCarriers ?? false) !== includeCarriers
}

function errorText(code: ReasoningClearErrorCode, message: string, language: Language): string {
  if ((code === "unknown" || code === "conflict") && message.trim()) return message.trim()
  return language.t(ERROR_KEYS[code])
}

export function shouldCloseReasoningDialog(
  submitted: boolean,
  state: Pick<ReasoningState, "applying" | "previewing"> & { applied?: unknown },
): boolean {
  return submitted && state.applied !== undefined && !state.applying && !state.previewing
}

export function reasoningClearToast(message: SessionReasoningClearedMessage, language: Language) {
  return {
    variant: "success" as const,
    title: language.t("command.session.reasoningClear.success", {
      parts: String(message.parts),
      turns: String(message.turns),
      tokens: message.tokens.toLocaleString(language.locale()),
    }),
  }
}

function id(): string {
  return crypto.randomUUID()
}

export function createSessionReasoning(deps: Deps) {
  const [store, setStore] = createStore<Record<string, ReasoningState>>({})
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function state(sessionID: string): ReasoningState {
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

  function request(
    sessionID: string,
    keepTurns: number,
    includeCarriers: boolean,
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
      includeCarriers,
      requestID,
      preview: undefined,
      previewing: true,
      applying: false,
      applied: undefined,
      error: notice,
    })
    deps.post({ type: "sessionReasoningClearPreview", sessionID, requestID, keepTurns, includeCarriers })
  }

  function preview(sessionID: string, keepTurns: number, opts?: { delay?: number; includeCarriers?: boolean }) {
    cancel(sessionID)
    const includeCarriers = opts?.includeCarriers ?? false
    const delay = opts?.delay ?? 0
    if (delay > 0) {
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          const current = state(sessionID)
          if (
            current.keepTurns === keepTurns &&
            current.includeCarriers === includeCarriers &&
            (current.previewing || current.preview !== undefined)
          )
            return
          request(sessionID, keepTurns, includeCarriers)
        }, delay),
      )
      return
    }
    request(sessionID, keepTurns, includeCarriers)
  }

  function apply(sessionID: string, keepTurns: number, token: string, includeCarriers = false) {
    cancel(sessionID)
    if (previewStale(state(sessionID).preview, keepTurns, includeCarriers)) {
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
      includeCarriers,
      requestID,
      applying: true,
      previewing: false,
      applied: undefined,
      error: undefined,
    })
    deps.post({ type: "sessionReasoningClear", sessionID, requestID, keepTurns, token, includeCarriers })
  }

  function handleMessage(message: ExtensionMessage): boolean {
    if (message.type === "sessionDeleted") {
      drop(message.sessionID)
      return false
    }
    if (
      message.type !== "sessionReasoningClearPreviewed" &&
      message.type !== "sessionReasoningCleared" &&
      message.type !== "sessionReasoningClearFailed"
    )
      return false

    const current = state(message.sessionID)
    if (current.requestID !== message.requestID) return true

    if (message.type === "sessionReasoningClearPreviewed") {
      setStore(message.sessionID, {
        ...current,
        previewing: false,
        applying: false,
        error: current.error?.code === "stale" ? current.error : undefined,
        preview: {
          keepTurns: current.keepTurns,
          includeCarriers: current.includeCarriers,
          turns: message.turns,
          parts: message.parts,
          tokens: message.tokens,
          carriers: message.carriers ?? 0,
          carrierCandidates: message.carrierCandidates ?? 0,
          unsupported: message.unsupported,
          token: message.token,
        },
      })
      return true
    }

    if (message.type === "sessionReasoningCleared") {
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
        showToast(reasoningClearToast(message, deps.language))
      }
      return true
    }

    fail(message.sessionID, message.code, message.error)
    const notice = state(message.sessionID).error
    if (message.operation === "apply" && message.code === "stale") {
      if (notice) request(message.sessionID, current.keepTurns, current.includeCarriers, notice)
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
