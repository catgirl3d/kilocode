import { routeSuggestionWebviewMessage } from "./handlers/suggestion"
import { routeInputToolMessage } from "../services/input-tools"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { SpeechToTextSource } from "../speech-to-text/source"
import type { SuggestionContext } from "./handlers/suggestion"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { buildChatSettingsMessage } from "./chat-settings"
import { buildThroughputSettingMessage } from "./throughput-settings"
import { buildAutoApprovalReasonSettingMessage } from "./auto-approval-reason-settings"
import type { ModelUsageMessage } from "./model-usage"
import { handleSessionTagsMessage } from "../session-tags" // fork_change
import { handleSessionFavoritesMessage } from "../session-favorites" // fork_change

type Ctx = {
  question: SuggestionContext
  client: KiloClient | null
  connection: KiloConnectionService
  dir: string
  post: (msg: unknown) => void
  browserSettings: () => void
  exportTranscript: (sessionID: string) => Promise<void>
  resume: (sessionID: string, messageID: string, requestID: string) => Promise<void>
  copy: (text: string) => PromiseLike<void>
  openSessions: (ids: string[]) => void
  activity: (state: unknown) => void
  speechToTextModels: () => Promise<void>
  speechToTextSource: () => SpeechToTextSource | undefined
  modelUsage: (message: ModelUsageMessage) => Promise<void>
  backgroundJobs: (sessionID: string, requestID: string) => Promise<void>
  board: (message: Record<string, unknown>) => Promise<boolean>
  cancelBackgroundJob: (jobID: string, sessionID: string, requestID: string) => Promise<void>
  promoteBackgroundJob: (jobID: string, sessionID: string) => Promise<void>
  caffeination: () => void
  // fork_change start
  shake: (sessionID: string) => Promise<void>
  reasoningPreview: (sessionID: string, requestID: string, keepTurns: number, includeCarriers: boolean) => Promise<void>
  reasoningClear: (
    sessionID: string,
    requestID: string,
    keepTurns: number,
    includeCarriers: boolean,
    token: string,
  ) => Promise<void>
  toolPreview: (sessionID: string, requestID: string, keepTurns: number) => Promise<void>
  toolClear: (sessionID: string, requestID: string, keepTurns: number, token: string) => Promise<void>
  sessionColors: () => void
  setSessionColor: (sessionID: string, color: string | null) => Promise<void>
  sessionTagProject: () => string | undefined
  // fork_change end
}

async function routeBackgroundMessage(
  message: { type: string; sessionID?: unknown; jobID?: unknown; requestID?: unknown },
  ctx: Ctx,
): Promise<boolean | undefined> {
  if (message.type === "toggleCaffeination") {
    ctx.caffeination()
    return true
  }
  if (message.type === "requestSessionBoard" || message.type === "resetSessionBoard") return ctx.board(message)
  if (message.type === "requestBackgroundJobs") {
    if (typeof message.sessionID === "string" && typeof message.requestID === "string") {
      await ctx.backgroundJobs(message.sessionID, message.requestID)
    }
    return true
  }
  if (message.type === "cancelBackgroundJob") {
    if (
      typeof message.jobID === "string" &&
      typeof message.sessionID === "string" &&
      typeof message.requestID === "string"
    ) {
      await ctx.cancelBackgroundJob(message.jobID, message.sessionID, message.requestID)
    }
    return true
  }
  if (message.type === "promoteBackgroundJob") {
    if (typeof message.jobID === "string" && typeof message.sessionID === "string") {
      await ctx.promoteBackgroundJob(message.jobID, message.sessionID)
    }
    return true
  }
  return undefined
}

function isResume(input: { sessionID?: unknown; messageID?: unknown; requestID?: unknown }): input is {
  sessionID: string
  messageID: string
  requestID: string
} {
  return (
    typeof input.sessionID === "string" && typeof input.messageID === "string" && typeof input.requestID === "string"
  )
}

// fork_change start
const CLEAR_MESSAGES = {
  sessionReasoningClearPreview: { kind: "reasoning", operation: "preview" },
  sessionReasoningClear: { kind: "reasoning", operation: "apply" },
  sessionToolClearPreview: { kind: "tool", operation: "preview" },
  sessionToolClear: { kind: "tool", operation: "apply" },
} as const

type ClearMessage = {
  type: keyof typeof CLEAR_MESSAGES
  sessionID?: unknown
  requestID?: unknown
  keepTurns?: unknown
  includeCarriers?: unknown
  token?: unknown
}

function isClearMessage(message: { type: string }): message is ClearMessage {
  return Object.hasOwn(CLEAR_MESSAGES, message.type)
}

async function routeClearMessage(message: ClearMessage, ctx: Ctx): Promise<boolean> {
  const spec = CLEAR_MESSAGES[message.type]
  const operation = spec.operation
  const sessionID = message.sessionID
  const requestID = message.requestID
  const keepTurns = message.keepTurns
  const token = message.token
  const includeCarriers = message.includeCarriers === true
  const validTurns = typeof keepTurns === "number"
  const validToken = operation === "preview" || (typeof token === "string" && token.length > 0)
  const validCarriers = message.includeCarriers === undefined || typeof message.includeCarriers === "boolean"
  if (typeof sessionID !== "string" || typeof requestID !== "string" || !validTurns || !validToken || !validCarriers) {
    if (typeof sessionID === "string" && typeof requestID === "string") {
      ctx.post({
        type: spec.kind === "reasoning" ? "sessionReasoningClearFailed" : "sessionToolClearFailed",
        operation,
        sessionID,
        requestID,
        code: "invalid",
        error: `Invalid ${spec.kind} clear request`,
      })
    }
    return true
  }
  if (spec.kind === "reasoning") {
    if (operation === "preview") await ctx.reasoningPreview(sessionID, requestID, keepTurns, includeCarriers)
    else await ctx.reasoningClear(sessionID, requestID, keepTurns, includeCarriers, token as string)
    return true
  }
  if (operation === "preview") await ctx.toolPreview(sessionID, requestID, keepTurns)
  else await ctx.toolClear(sessionID, requestID, keepTurns, token as string)
  return true
}

async function routeSessionMessage(
  message: {
    type: string
    sessionID?: unknown
    sessionId?: unknown
    messageID?: unknown
    requestID?: unknown
    color?: unknown
    keepTurns?: unknown
    token?: unknown
  },
  ctx: Ctx,
): Promise<boolean | undefined> {
  if (await handleSessionFavoritesMessage(message, ctx.post)) return true
  if (await handleSessionTagsMessage(message, ctx.post, ctx.sessionTagProject ? ctx.sessionTagProject() : undefined))
    return true
  if (message.type === "resumeSession") {
    if (isResume(message)) await ctx.resume(message.sessionID, message.messageID, message.requestID)
    return true
  }
  if (message.type === "shake") {
    if (typeof message.sessionID === "string") await ctx.shake(message.sessionID)
    return true
  }
  if (isClearMessage(message)) return routeClearMessage(message, ctx)
  if (message.type === "setSessionColor") {
    if (typeof message.sessionId === "string" && (message.color === null || typeof message.color === "string")) {
      await ctx.setSessionColor(message.sessionId, message.color)
    }
    return true
  }
  return undefined
}
export async function routeEarlyMessage(
  message: { type: string; id?: unknown; text?: unknown; state?: unknown },
  ctx: Ctx,
): Promise<boolean> {
  const session = await routeSessionMessage(message, ctx)
  if (session !== undefined) return session
  // fork_change end
  if (message.type === "copyToClipboard") {
    if (typeof message.id !== "string") return true
    if (typeof message.text !== "string") {
      ctx.post({ type: "clipboardWriteResult", id: message.id, ok: false, error: "Invalid clipboard text" })
      return true
    }
    await ctx.copy(message.text).then(
      () => ctx.post({ type: "clipboardWriteResult", id: message.id, ok: true }),
      (err) =>
        ctx.post({
          type: "clipboardWriteResult",
          id: message.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    )
    return true
  }
  if (message.type === "recordModelUsage" || message.type === "requestModelUsage") {
    await ctx.modelUsage(message as ModelUsageMessage)
    return true
  }
  await routeSuggestionWebviewMessage(ctx.question, message)
  if (message.type === "exportSessionTranscript") {
    const input = message as { sessionID?: unknown }
    if (typeof input.sessionID === "string") await ctx.exportTranscript(input.sessionID)
    return true
  }
  if (message.type === "sessionActivity") {
    ctx.activity(message.state)
    return true
  }
  if (message.type === "sidebar.openSessions") {
    const input = message as { sessionIDs?: unknown }
    const ids = Array.isArray(input.sessionIDs)
      ? input.sessionIDs.filter((id): id is string => typeof id === "string")
      : []
    ctx.openSessions(ids)
    return true
  }
  if (message.type === "requestChatSettings") {
    ctx.post(buildChatSettingsMessage())
    return true
  }
  if (message.type === "requestThroughputSetting") {
    ctx.post(buildThroughputSettingMessage())
    return true
  }
  if (message.type === "requestAutoApprovalReasonSetting") {
    ctx.post(buildAutoApprovalReasonSettingMessage())
    return true
  }
  if (message.type === "requestSpeechToTextModels") {
    await ctx.speechToTextModels()
    return true
  }
  // fork_change start
  if (message.type === "requestSessionColors") {
    ctx.sessionColors()
    return true
  }
  // fork_change end
  if (message.type === "requestBrowserSettings") {
    ctx.browserSettings()
    return true
  }
  const background = await routeBackgroundMessage(message, ctx)
  return (
    background ??
    (await routeInputToolMessage(message, {
      connection: ctx.connection,
      dir: ctx.dir,
      post: ctx.post,
      speechSource: ctx.speechToTextSource,
    }))
  )
}
